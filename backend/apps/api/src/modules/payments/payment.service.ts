import createHttpError from "http-errors";
import { AuditEntityType, Prisma, PrismaClient } from "@prisma/client";
import {
  FulfillmentStatus,
  OrderStatusDomain,
  Payment,
  PaymentMethod,
  PaymentStatus,
} from "../orders/order.types";
import { PaymentRepository } from "./payment.repository";
import { generatePaymentCode } from "../orders/order-code";
import { prisma } from "../../db";
import type { AccessIdentity } from "../auth/auth.types";
import { assertOrderAccess } from "../auth/order-access.policy";

export interface ConfirmCashInput {
  confirmedByUserId?: string;
  amount?: number;
}

export interface InitQrPaymentInput {
  requestedByUserId?: string;
}

export interface InitQrPaymentResult {
  payment: Payment;
  transferContent: string;
  amount: bigint;
}

export class PaymentService {
  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly database: PrismaClient = prisma,
  ) {}

  public async listOrderPayments(
    orderId: string,
    actor: AccessIdentity,
  ): Promise<Payment[]> {
    const order = await this.database.order.findUnique({ where: { id: orderId } });
    if (!order) throw createHttpError(404, `Order ${orderId} not found`);
    assertOrderAccess(actor, order, "read");

    return this.paymentRepository.findManyByOrderId(orderId);
  }

  public async confirmCash(
    orderId: string,
    input: ConfirmCashInput,
    actor: AccessIdentity,
  ): Promise<Payment> {
    const confirmedByUserId = actor.userId;

    return this.runSerializable(async (tx, attempt) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { payment: true },
      });

      if (!order) throw createHttpError(404, `Order ${orderId} not found`);
      assertOrderAccess(actor, order, "pay");
      if (!order.payment) {
        throw createHttpError(409, `Payment record for order ${orderId} has not been created`);
      }

      if (order.paymentStatus !== PaymentStatus.UNPAID) {
        throw createHttpError(409, `Order payment status must be UNPAID. Current: ${order.paymentStatus}`);
      }

      if (order.fulfillmentStatus !== FulfillmentStatus.PENDING_PAYMENT) {
        throw createHttpError(
          409,
          `Order fulfillment status must be PENDING_PAYMENT. Current: ${order.fulfillmentStatus}`
        );
      }

      if (order.payment.confirmedAt || order.payment.receivedAmount > BigInt(0)) {
        throw createHttpError(409, "Cash payment already confirmed");
      }

      const receivedAmount =
        input.amount === undefined ? order.totalAmount : BigInt(input.amount);

      if (receivedAmount !== order.totalAmount) {
        throw createHttpError(
          attempt > 0 ? 409 : 400,
          attempt > 0
            ? "Order total changed while cash confirmation was in progress"
            : "Cash amount must match the order total amount",
        );
      }

      const paymentUpdate = await tx.payment.updateMany({
        where: {
          id: order.payment.id,
          confirmedAt: null,
          receivedAmount: BigInt(0),
        },
        data: {
          receivedAmount,
          cashConfirmedByUserId: confirmedByUserId,
          confirmedAt: new Date(),
        },
      });

      if (paymentUpdate.count !== 1) {
        throw createHttpError(409, "Cash payment already confirmed");
      }

      const orderUpdate = await tx.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: PaymentStatus.UNPAID as any,
          fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT as any,
        },
        data: {
          paymentMethod: "CASH" as any,
          paymentStatus: PaymentStatus.PAID as any,
          fulfillmentStatus: FulfillmentStatus.QUEUED as any,
          paidAt: new Date(),
        },
      });

      if (orderUpdate.count !== 1) {
        throw createHttpError(409, "Order is no longer eligible for cash confirmation");
      }

      await tx.orderStatusHistory.createMany({
        data: [
          {
            orderId,
            statusDomain: OrderStatusDomain.PAYMENT as any,
            oldStatus: PaymentStatus.UNPAID,
            newStatus: PaymentStatus.PAID,
            changedByUserId: confirmedByUserId,
            reason: "Cash payment confirmed",
          },
          {
            orderId,
            statusDomain: OrderStatusDomain.FULFILLMENT as any,
            oldStatus: FulfillmentStatus.PENDING_PAYMENT,
            newStatus: FulfillmentStatus.QUEUED,
            changedByUserId: confirmedByUserId,
            reason: "Cash payment confirmed",
          },
        ],
      });

      const payment = await tx.payment.findUnique({
        where: { id: order.payment.id },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: confirmedByUserId,
          action: "CASH_PAYMENT_CONFIRMED",
          entityType: AuditEntityType.PAYMENT,
          entityId: order.payment.id,
          details: {
            orderId,
            orderCode: order.orderCode,
            amount: receivedAmount.toString(),
            previousPaymentStatus: order.paymentStatus,
            newPaymentStatus: PaymentStatus.PAID,
            previousFulfillmentStatus: order.fulfillmentStatus,
            newFulfillmentStatus: FulfillmentStatus.QUEUED,
          },
        },
      });

      return payment as unknown as Payment;
    });
  }

  public async initQrPayment(
    orderId: string,
    _input: InitQrPaymentInput,
    actor: AccessIdentity,
  ): Promise<InitQrPaymentResult> {
    const requestedByUserId = actor.userId;

    return this.runSerializable(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { payment: true },
      });

      if (!order) throw createHttpError(404, `Order ${orderId} not found`);
      assertOrderAccess(actor, order, "pay");

      if (order.paymentStatus === PaymentStatus.PENDING && order.paymentMethod === PaymentMethod.QR) {
        if (!order.payment) {
          throw createHttpError(409, `Payment record for order ${orderId} has not been created`);
        }

        return {
          payment: order.payment as unknown as Payment,
          transferContent: this.buildQrTransferContent(order.orderCode, order.payment.paymentCode),
          amount: order.payment.expectedAmount,
        };
      }

      if (order.paymentStatus !== PaymentStatus.UNPAID) {
        throw createHttpError(409, `Order payment status must be UNPAID. Current: ${order.paymentStatus}`);
      }

      if (order.fulfillmentStatus !== FulfillmentStatus.PENDING_PAYMENT) {
        throw createHttpError(
          409,
          `Order fulfillment status must be PENDING_PAYMENT. Current: ${order.fulfillmentStatus}`
        );
      }

      const paymentCode = order.payment?.paymentCode ?? generatePaymentCode(order.orderCode);

      const payment = order.payment
        ? await tx.payment.update({
            where: { id: order.payment.id },
            data: {
              paymentCode,
              expectedAmount: order.totalAmount,
              receivedAmount: BigInt(0),
              cashConfirmedByUserId: null,
              confirmedAt: null,
            },
          })
        : await tx.payment.create({
            data: {
              orderId,
              paymentCode,
              expectedAmount: order.totalAmount,
              receivedAmount: BigInt(0),
            },
          });

      const orderUpdate = await tx.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: PaymentStatus.UNPAID as any,
          fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT as any,
        },
        data: {
          paymentMethod: PaymentMethod.QR as any,
          paymentStatus: PaymentStatus.PENDING as any,
        },
      });

      if (orderUpdate.count !== 1) {
        throw createHttpError(409, "Order is no longer eligible for QR payment initialization");
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          statusDomain: OrderStatusDomain.PAYMENT as any,
          oldStatus: PaymentStatus.UNPAID,
          newStatus: PaymentStatus.PENDING,
          changedByUserId: requestedByUserId,
          reason: "QR payment initialized",
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: requestedByUserId,
          action: "QR_PAYMENT_INITIALIZED",
          entityType: AuditEntityType.PAYMENT,
          entityId: payment.id,
          details: {
            orderId,
            orderCode: order.orderCode,
            paymentCode,
            expectedAmount: payment.expectedAmount.toString(),
            previousPaymentStatus: order.paymentStatus,
            newPaymentStatus: PaymentStatus.PENDING,
          },
        },
      });

      return {
        payment: payment as unknown as Payment,
        transferContent: this.buildQrTransferContent(order.orderCode, payment.paymentCode),
        amount: payment.expectedAmount,
      };
    });
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient, attempt: number) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.$transaction(
          (tx) => operation(tx, attempt),
          {
            isolationLevel: "Serializable",
            maxWait: 5_000,
            timeout: 10_000,
          },
        );
      } catch (error) {
        if ((error as { code?: string }).code === "P2034" && attempt < 2) {
          continue;
        }
        if ((error as { code?: string }).code === "P2034") {
          throw createHttpError(409, "Payment operation conflicted with another request; retry with fresh state");
        }
        throw error;
      }
    }

    throw createHttpError(409, "Payment operation conflicted with another request; retry with fresh state");
  }

  private buildQrTransferContent(orderCode: string, paymentCode?: string | null): string {
    return `${paymentCode ?? generatePaymentCode(orderCode)} ${orderCode}`;
  }
}
