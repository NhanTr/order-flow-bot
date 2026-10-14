import createHttpError from "http-errors";
import { AuditEntityType, Prisma, PrismaClient, TransactionMatchStatus } from "@prisma/client";
import { timingSafeEqual } from "node:crypto";
import {
  FulfillmentStatus,
  OrderStatusDomain,
  PaymentMethod,
  PaymentStatus,
} from "../orders/order.types";
import {
  recordOrderNotification,
  recordPaymentReviewNotifications,
} from "../notifications/notification-outbox.service";
import { prisma } from "../../db";
import { parseSepayWebhook } from "./sepay.validation";
import {
  NormalizedSepayTransaction,
  SepayTransactionNormalizationError,
} from "./sepay-transaction";

const SERIALIZABLE_ATTEMPTS = 3;

function prismaErrorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function isExternalTransactionIdConflict(error: unknown): boolean {
  if (prismaErrorCode(error) !== "P2002") return false;
  const target = JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? "");
  return /sepay_transaction_id|sepayTransactionId|sepay_transactions_sepay_transaction_id_key/i.test(target);
}

export interface SepayWebhookResult {
  duplicate: boolean;
  matched: boolean;
  ignored?: boolean;
  transactionId: string;
  paymentId?: string | null;
  matchStatus: TransactionMatchStatus;
}

export class SepayService {
  constructor(private readonly db: PrismaClient = prisma) {}

  public async handleWebhook(payload: any, headers: Record<string, any>): Promise<SepayWebhookResult> {
    this.verifyWebhook(headers);

    let normalized: NormalizedSepayTransaction;
    try {
      normalized = parseSepayWebhook(payload);
    } catch (error) {
      if (error instanceof SepayTransactionNormalizationError) {
        throw createHttpError(400, error.message);
      }
      throw error;
    }

    return this.handleTrustedTransaction(normalized);
  }

  public async handleTrustedTransaction(normalized: NormalizedSepayTransaction): Promise<SepayWebhookResult> {
    const configuredAccount = process.env.SEPAY_BANK_ACCOUNT?.trim();
    if (!configuredAccount) {
      throw createHttpError(503, "SePay bank account is not configured");
    }
    if (normalized.accountNumber !== configuredAccount || normalized.direction !== "in") {
      return {
        duplicate: false,
        matched: false,
        ignored: true,
        transactionId: normalized.externalId,
        paymentId: null,
        matchStatus: TransactionMatchStatus.UNMATCHED,
      };
    }

    return this.runSerializable(normalized);
  }

  private async ingestTransaction(
    tx: Prisma.TransactionClient,
    normalized: NormalizedSepayTransaction,
  ): Promise<SepayWebhookResult> {
      const existing = await tx.sepayTransaction.findUnique({
        where: { sepayTransactionId: normalized.externalId },
      });

      if (existing) {
        return {
          duplicate: true,
          matched: existing.matchStatus === TransactionMatchStatus.MATCHED,
          transactionId: existing.id,
          paymentId: existing.paymentId,
          matchStatus: existing.matchStatus,
        };
      }

      const candidate = await this.findPaymentCandidate(tx, normalized);
      const classification = candidate
        ? this.classifyCandidate(candidate, normalized.amountIn)
        : {
            paymentStatus: null,
            fulfillmentStatus: null,
            matchStatus: TransactionMatchStatus.WRONG_CODE,
            differenceAmount: null,
            matched: false,
            applyStateChanges: false,
            reason: "SePay transaction did not contain exactly one known payment code",
          };


      const transaction = await tx.sepayTransaction.create({
        data: {
          sepayTransactionId: normalized.externalId,
          paymentId: candidate?.id ?? null,
          transactionDate: normalized.transactionDate,
          code: normalized.paymentCode,
          content: normalized.content,
          amountIn: normalized.amountIn,
          referenceCode: normalized.referenceCode,
          matchStatus: classification.matchStatus,
          differenceAmount: classification.differenceAmount,
          rawPayload: normalized.rawPayload,
        },
      });

      if (candidate && classification.applyStateChanges) {
        const orderData: any = {};
        if (classification.paymentStatus) {
          orderData.paymentStatus = classification.paymentStatus as any;
        }
        if (classification.fulfillmentStatus) {
          orderData.fulfillmentStatus = classification.fulfillmentStatus as any;
        }
        if (classification.matched) {
          orderData.paidAt = new Date();
        }

        if (Object.keys(orderData).length > 0) {
          await tx.order.update({
            where: {
              id: candidate.orderId,
              paymentMethod: candidate.order.paymentMethod,
              paymentStatus: candidate.order.paymentStatus,
              fulfillmentStatus: candidate.order.fulfillmentStatus,
            },
            data: orderData,
          });
        }

        await tx.payment.update({
          where: { id: candidate.id, receivedAmount: candidate.receivedAmount },
          data: { receivedAmount: normalized.amountIn },
        });

        const historyRows = [];
        if (
          classification.paymentStatus &&
          candidate.order.paymentStatus !== classification.paymentStatus
        ) {
          historyRows.push({
            orderId: candidate.orderId,
            statusDomain: OrderStatusDomain.PAYMENT as any,
            oldStatus: candidate.order.paymentStatus,
            newStatus: classification.paymentStatus,
            reason: classification.reason,
          });
        }
        if (
          classification.fulfillmentStatus &&
          candidate.order.fulfillmentStatus !== classification.fulfillmentStatus
        ) {
          historyRows.push({
            orderId: candidate.orderId,
            statusDomain: OrderStatusDomain.FULFILLMENT as any,
            oldStatus: candidate.order.fulfillmentStatus,
            newStatus: classification.fulfillmentStatus,
            reason: classification.reason,
          });
        }

        if (historyRows.length > 0) {
          await tx.orderStatusHistory.createMany({ data: historyRows });
        }
      }

      if (classification.matched && candidate) {
        await recordOrderNotification(tx, "ORDER_PAID", candidate.orderId);
      }

      if (!classification.matched) {
        await recordPaymentReviewNotifications(tx, {
          sourceKey: `sepay:${transaction.id}`,
          orderId: candidate?.orderId,
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: classification.matched
            ? "SEPAY_WEBHOOK_MATCHED"
            : "SEPAY_WEBHOOK_REVIEW_REQUIRED",
          entityType: AuditEntityType.SEPAY_TRANSACTION,
          entityId: transaction.id,
          details: {
            sepayTransactionId: normalized.externalId,
            paymentId: transaction.paymentId,
            orderId: candidate?.orderId ?? null,
            amountIn: normalized.amountIn.toString(),
            matchStatus: transaction.matchStatus,
            paymentStatus: classification.paymentStatus,
            fulfillmentStatus: classification.fulfillmentStatus,
            differenceAmount: classification.differenceAmount?.toString() ?? null,
            reason: classification.reason,
          },
        },
      });

    return {
      duplicate: false,
      matched: classification.matched,
      transactionId: transaction.id,
      paymentId: transaction.paymentId,
      matchStatus: transaction.matchStatus,
    };
  }

  private async runSerializable(normalized: NormalizedSepayTransaction): Promise<SepayWebhookResult> {
    for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.db.$transaction(
          (tx) => this.ingestTransaction(tx, normalized),
          { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
        );
      } catch (error) {
        if (isExternalTransactionIdConflict(error)) {
          const existing = await this.db.sepayTransaction.findUnique({
            where: { sepayTransactionId: normalized.externalId },
          });
          if (existing) {
            return {
              duplicate: true,
              matched: existing.matchStatus === TransactionMatchStatus.MATCHED,
              transactionId: existing.id,
              paymentId: existing.paymentId,
              matchStatus: existing.matchStatus,
            };
          }
        }
        if (["P2025", "P2034"].includes(prismaErrorCode(error) ?? "")) {
          if (attempt === SERIALIZABLE_ATTEMPTS) break;
          continue;
        }
        throw error;
      }
    }

    throw createHttpError(409, "SePay transaction could not be processed concurrently");
  }

  private verifyWebhook(headers: Record<string, any>) {
    const secret = process.env.SEPAY_WEBHOOK_API_KEY?.trim()
      || process.env.SEPAY_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw createHttpError(503, "SePay webhook API key is not configured");
    }

    const rawProvided =
      headers["x-sepay-webhook-secret"] ??
      headers["x-webhook-secret"] ??
      headers["authorization"];
    const provided = Array.isArray(rawProvided) ? rawProvided[0] : rawProvided;
    const normalized = typeof provided === "string"
      ? provided.replace(/^(?:Apikey|Bearer)\s+/i, "").trim()
      : "";
    const expectedBuffer = Buffer.from(secret);
    const providedBuffer = Buffer.from(normalized);
    const matches = expectedBuffer.length === providedBuffer.length
      && timingSafeEqual(expectedBuffer, providedBuffer);

    if (!matches) {
      throw createHttpError(401, "Invalid SePay webhook secret");
    }
  }


  private classifyCandidate(candidate: any, amountIn: bigint) {
    const differenceAmount = amountIn - candidate.expectedAmount;

    if (
      candidate.order.paymentStatus === PaymentStatus.PAID
      || [
        FulfillmentStatus.PREPARING,
        FulfillmentStatus.READY,
        FulfillmentStatus.DELIVERED,
        FulfillmentStatus.CANCELLED,
      ].includes(candidate.order.fulfillmentStatus)
    ) {
      return {
        paymentStatus: null,
        fulfillmentStatus: null,
        matchStatus: TransactionMatchStatus.UNMATCHED,
        differenceAmount,
        matched: false,
        applyStateChanges: false,
        reason: "SePay transaction arrived after payment or fulfillment was settled",
      };
    }

    if (amountIn < candidate.expectedAmount) {
      return {
        paymentStatus: PaymentStatus.UNDERPAID,
        fulfillmentStatus: null,
        matchStatus: TransactionMatchStatus.UNMATCHED,
        differenceAmount,
        matched: false,
        applyStateChanges: true,
        reason: "SePay transaction is underpaid",
      };
    }

    if (amountIn > candidate.expectedAmount) {
      return {
        paymentStatus: PaymentStatus.OVERPAID,
        fulfillmentStatus: null,
        matchStatus: TransactionMatchStatus.UNMATCHED,
        differenceAmount,
        matched: false,
        applyStateChanges: true,
        reason: "SePay transaction is overpaid",
      };
    }

    if (
      candidate.order.paymentMethod === PaymentMethod.QR &&
      candidate.order.paymentStatus === PaymentStatus.PENDING &&
      candidate.order.fulfillmentStatus === FulfillmentStatus.PENDING_PAYMENT
    ) {
      return {
        paymentStatus: PaymentStatus.PAID,
        fulfillmentStatus: FulfillmentStatus.QUEUED,
        matchStatus: TransactionMatchStatus.MATCHED,
        differenceAmount,
        matched: true,
        applyStateChanges: true,
        reason: "SePay webhook matched exact payment",
      };
    }

    return {
      paymentStatus: PaymentStatus.REVIEW,
      fulfillmentStatus: null,
      matchStatus: TransactionMatchStatus.UNMATCHED,
      differenceAmount,
      matched: false,
      applyStateChanges: false,
      reason: "SePay transaction needs manual payment review",
    };
  }

  private async findPaymentCandidate(
    tx: Prisma.TransactionClient,
    normalized: NormalizedSepayTransaction,
  ) {
    const tokens = new Set<string>();
    for (const value of [normalized.paymentCode, normalized.content, normalized.referenceCode]) {
      if (!value) continue;
      const matches = value.toUpperCase().match(/[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [];
      for (const token of matches) {
        if (token.length <= 40) tokens.add(token);
        if (tokens.size > 20) return null;
      }
    }
    if (tokens.size === 0) return null;

    const payments = await tx.payment.findMany({
      where: { paymentCode: { in: [...tokens] } },
      include: { order: true },
      take: 2,
    });
    return payments.length === 1 ? payments[0] : null;
  }
}
