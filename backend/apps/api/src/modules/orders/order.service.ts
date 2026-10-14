import createHttpError from "http-errors";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../db";
import { OrderRepository } from "./order.repository";
import { HistoryRepository } from "../order-status-history/history.repository";
import { PaymentRepository } from "../payments/payment.repository";
import {
  Order,
  CreateOrderInput,
  AddItemInput,
  UpdateItemInput,
  FulfillmentStatus,
  PaymentStatus,
  OrderStatusDomain,
  OrderFilters,
  PaginatedResult,
} from "./order.types";
import {
  isValidFulfillmentTransition,
  isOrderEditable,
  isFulfillmentTerminal,
  isValidPaymentTransition,
} from "./state-machine";
import type { AccessIdentity } from "../auth/auth.types";
import { assertOrderAccess } from "../auth/order-access.policy";
import { generatePaymentCode } from "./order-code";

function isRecordNotFoundError(error: unknown): boolean {
  return (error as { code?: string }).code === "P2025";
}

function isGeneratedCodeCollision(error: unknown): boolean {
  if ((error as { code?: string }).code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((field) =>
    field.includes("order_code") ||
    field.includes("orderCode") ||
    field.includes("payment_code") ||
    field.includes("paymentCode")
  );
}

/**
 * Orchestrates all business logic for the Order entity.
 * Coordinates OrderRepository, PaymentRepository, and HistoryRepository.
 */
export class OrderService {
  constructor(
    private readonly orderRepository:   OrderRepository,
    private readonly historyRepository: HistoryRepository,
    private readonly paymentRepository: PaymentRepository,
    private readonly database: PrismaClient = prisma,
  ) {}

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { retryGeneratedCodeCollisions?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.$transaction(operation, {
          isolationLevel: "Serializable",
          maxWait: 5_000,
          timeout: 10_000,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2034" && attempt < 2) {
          continue;
        }
        if (options.retryGeneratedCodeCollisions && isGeneratedCodeCollision(error) && attempt < 2) {
          continue;
        }
        if ((error as { code?: string }).code === "P2034") {
          throw createHttpError(409, "Order changed concurrently; retry with fresh state");
        }
        if (options.retryGeneratedCodeCollisions && isGeneratedCodeCollision(error)) {
          throw createHttpError(409, "Unable to allocate a unique order payment code after multiple attempts");
        }
        throw error;
      }
    }

    throw createHttpError(409, "Order changed concurrently; retry with fresh state");
  }

  // ─────────────────────────────────────────────────────────────
  // Customer endpoints
  // ─────────────────────────────────────────────────────────────

  /**
   * Creates a new order (fulfillmentStatus=PENDING_PAYMENT, paymentStatus=UNPAID)
   * and immediately creates a corresponding Payment record.
   *
   * Only active/available menu items in active categories can be ordered.
   * Prices and names are snapshotted directly from the database (client does not dictate price).
   *
   * Body: { createdByUserId, paymentMethod?, customerNote?, items[] }
   */
  public async createOrder(input: CreateOrderInput, actor: AccessIdentity): Promise<Order> {
    if (actor.role === "BARISTA") {
      throw createHttpError(403, "Baristas cannot create web orders");
    }

    if (!input.items || input.items.length === 0) {
      throw createHttpError(400, "An order must have at least one item");
    }

    return this.runSerializable(async (tx) => {
      const enrichedItems: Array<{ menuItemId: string; itemName: string; unitPrice: bigint; quantity: number; note?: string }> = [];

      for (const item of input.items) {
        if (item.quantity <= 0) {
          throw createHttpError(400, "Quantity must be greater than 0");
        }

        const menuItem = await tx.menuItem.findUnique({
          where: { id: item.menuItemId },
          include: { category: true },
        });

        if (!menuItem) {
          throw createHttpError(404, `Menu item with ID ${item.menuItemId} not found`);
        }
        if (!menuItem.isAvailable) {
          throw createHttpError(400, `Menu item "${menuItem.name}" is not currently available`);
        }
        if (!menuItem.category.isActive) {
          throw createHttpError(400, `Menu category "${menuItem.category.name}" is not currently active`);
        }

        enrichedItems.push({
          menuItemId: item.menuItemId,
          itemName: menuItem.name,
          unitPrice: menuItem.price,
          quantity: item.quantity,
          note: item.note,
        });
      }

      const order = await this.orderRepository.create(
        actor.userId,
        input.paymentMethod,
        input.customerNote,
        enrichedItems,
        tx,
      );

      await tx.payment.create({
        data: {
          orderId: order.id,
          paymentCode: generatePaymentCode(order.orderCode),
          expectedAmount: order.totalAmount,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          statusDomain: OrderStatusDomain.FULFILLMENT as any,
          oldStatus: null,
          newStatus: FulfillmentStatus.PENDING_PAYMENT,
          changedByUserId: actor.userId,
        },
      });

      return order;
    }, { retryGeneratedCodeCollisions: true });
  }

  /**
   * Retrieves a paginated, filtered list of orders.
   */
  public async getOrders(
    filters: OrderFilters = {},
    actor: AccessIdentity,
  ): Promise<PaginatedResult<Order>> {
    if (actor.role === "BARISTA") {
      throw createHttpError(403, "Baristas cannot access web orders");
    }

    const authorizedFilters = actor.role === "SERVICE_STAFF"
      ? { ...filters, createdByUserId: actor.userId }
      : filters;
    return this.orderRepository.findAll(authorizedFilters);
  }

  /**
   * Retrieves a single order by ID.
   * @throws 404 if not found.
   */
  public async getOrderById(id: string, actor: AccessIdentity): Promise<Order> {
    const order = await this.orderRepository.findById(id);
    if (!order) throw createHttpError(404, `Order ${id} not found`);
    assertOrderAccess(actor, order, "read");
    return order;
  }

  /**
   * Adds an item to an order that is still in PENDING_PAYMENT / UNPAID status.
   * Resolves price/name from the MenuItem database record.
   *
   * @throws 404 order/item not found.
   * @throws 409 if order is not editable (already paid or processing).
   */
  public async addItem(
    orderId:       string,
    item:          AddItemInput,
    actor:          AccessIdentity,
  ): Promise<Order> {
    if (item.quantity <= 0) {
      throw createHttpError(400, "Quantity must be greater than 0");
    }

    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);
        assertOrderAccess(actor, order, "edit");
        if (order.paymentStatus !== PaymentStatus.UNPAID || order.fulfillmentStatus !== FulfillmentStatus.PENDING_PAYMENT) {
          throw createHttpError(409, "Order is no longer editable");
        }

        const menuItem = await tx.menuItem.findUnique({
          where: { id: item.menuItemId },
          include: { category: true },
        });
        if (!menuItem) throw createHttpError(404, `Menu item with ID ${item.menuItemId} not found`);
        if (!menuItem.isAvailable) {
          throw createHttpError(400, `Menu item "${menuItem.name}" is not currently available`);
        }
        if (!menuItem.category.isActive) {
          throw createHttpError(400, `Menu category "${menuItem.category.name}" is not currently active`);
        }

        return this.orderRepository.addItem(orderId, {
          menuItemId: item.menuItemId,
          itemName: menuItem.name,
          unitPrice: menuItem.price,
          quantity: item.quantity,
          note: item.note,
        }, tx);
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order is no longer editable");
      }
      throw error;
    }
  }

  /**
   * Updates a specific item (quantity or note) on a PENDING_PAYMENT / UNPAID order.
   *
   * @throws 404 if order or item not found.
   * @throws 409 if order is not editable.
   */
  public async updateItem(
    orderId:      string,
    itemId:       string,
    input:        UpdateItemInput,
    actor:        AccessIdentity,
  ): Promise<Order> {
    if (input.quantity !== undefined && input.quantity <= 0) {
      throw createHttpError(400, "Quantity must be greater than 0");
    }

    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);
        assertOrderAccess(actor, order, "edit");
        if (order.paymentStatus !== PaymentStatus.UNPAID || order.fulfillmentStatus !== FulfillmentStatus.PENDING_PAYMENT) {
          throw createHttpError(409, "Order is no longer editable");
        }

        const existingItem = await this.orderRepository.findItemById(orderId, itemId, tx);
        if (!existingItem) throw createHttpError(404, `Item ${itemId} not found in order ${orderId}`);
        return this.orderRepository.updateItem(orderId, itemId, input, tx);
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order is no longer editable");
      }
      throw error;
    }
  }

  /**
   * Deletes an item from a PENDING_PAYMENT / UNPAID order.
   * Prevents deleting the last item.
   *
   * @throws 400 if the item is the last one.
   * @throws 404 if order or item not found.
   * @throws 409 if order is not editable.
   */
  public async deleteItem(
    orderId:      string,
    itemId:       string,
    actor:        AccessIdentity,
  ): Promise<Order> {
    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);
        assertOrderAccess(actor, order, "edit");
        if (order.paymentStatus !== PaymentStatus.UNPAID || order.fulfillmentStatus !== FulfillmentStatus.PENDING_PAYMENT) {
          throw createHttpError(409, "Order is no longer editable");
        }

        const existingItem = await this.orderRepository.findItemById(orderId, itemId, tx);
        if (!existingItem) throw createHttpError(404, `Item ${itemId} not found in order ${orderId}`);
        if (order.items.length === 1) {
          throw createHttpError(400, "Cannot remove the last item from an order");
        }
        return this.orderRepository.deleteItem(orderId, itemId, tx);
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order is no longer editable");
      }
      throw error;
    }
  }

  /**
   * Cancels an order.
   * - Allowed for: PENDING_PAYMENT, QUEUED, PREPARING (not READY, DELIVERED, CANCELLED)
   * - `reason` is REQUIRED (enforced by SQL constraint orders_cancellation_reason_chk)
   *
   * @throws 400 if reason is missing.
   * @throws 404 if order not found.
   * @throws 409 if transition is not allowed.
   */
  public async cancelOrder(
    orderId:      string,
    reason:       string,
    actor:        AccessIdentity,
  ): Promise<Order> {
    if (!reason || reason.trim() === "") {
      throw createHttpError(400, "cancellation reason is required");
    }

    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);
        assertOrderAccess(actor, order, "cancel");
        const current = order.fulfillmentStatus;
        if (!isValidFulfillmentTransition(current, FulfillmentStatus.CANCELLED)) {
          throw createHttpError(409, `Cannot cancel an order in ${current} status`);
        }

        const updated = await this.orderRepository.updateFulfillmentStatus(
          orderId,
          FulfillmentStatus.CANCELLED,
          { cancellationReason: reason.trim() },
          tx,
          { fulfillmentStatus: current },
        );
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            statusDomain: OrderStatusDomain.FULFILLMENT as any,
            oldStatus: current,
            newStatus: FulfillmentStatus.CANCELLED,
            changedByUserId: actor.userId,
            reason: reason.trim(),
          },
        });
        return updated;
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order status changed concurrently");
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Barista endpoints
  // ─────────────────────────────────────────────────────────────

  /**
   * Barista claims a QUEUED order → PREPARING.
   *
   * Guards:
   * 1. Order must be QUEUED and paymentStatus must be PAID.
   * 2. Operation must be atomic (prevents double-assignment race conditions).
   *
   * @throws 404 if order not found.
   * @throws 409 if order cannot be claimed (already assigned, unpaid, or not queued).
   */
  public async claimOrder(
    orderId: string,
    baristaId: string,
    actor: AccessIdentity,
  ): Promise<Order> {
    if (actor.role !== "OWNER") {
      throw createHttpError(403, "Only owners can assign web orders to baristas");
    }

    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);

        const activeBarista = await tx.user.findFirst({
          where: { id: baristaId, role: "BARISTA", status: "ACTIVE" },
          select: { id: true },
        });
        if (!activeBarista) {
          throw createHttpError(400, "Orders can only be assigned to an active BARISTA user.");
        }
        if (
          order.fulfillmentStatus !== FulfillmentStatus.QUEUED ||
          order.paymentStatus !== PaymentStatus.PAID ||
          order.assignedBaristaId !== null
        ) {
          throw createHttpError(409, "Order cannot be claimed. It may already be claimed, not paid, or not in QUEUED status.");
        }

        const updated = await this.orderRepository.updateFulfillmentStatus(
          orderId,
          FulfillmentStatus.PREPARING,
          { assignedBaristaId: baristaId },
          tx,
          {
            fulfillmentStatus: FulfillmentStatus.QUEUED,
            paymentStatus: PaymentStatus.PAID,
            assignedBaristaId: null,
          },
        );
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            statusDomain: OrderStatusDomain.FULFILLMENT as any,
            oldStatus: FulfillmentStatus.QUEUED,
            newStatus: FulfillmentStatus.PREPARING,
            changedByUserId: actor.userId,
          },
        });
        return updated;
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order cannot be claimed. It may already be claimed, not paid, or not in QUEUED status.");
      }
      throw error;
    }
  }

  /**
   * OWNER web override from PREPARING to READY.
   * Assigned baristas use the separately authenticated Telegram flow.
   */
  public async markReady(
    orderId: string,
    reason: string | undefined,
    actor: AccessIdentity,
  ): Promise<Order> {
    if (actor.role !== "OWNER") {
      throw createHttpError(403, "Only owners can mark web orders as READY");
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw createHttpError(400, "reason is required for an owner READY override");
    }

    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);
        const current = order.fulfillmentStatus;
        if (!isValidFulfillmentTransition(current, FulfillmentStatus.READY)) {
          throw createHttpError(409, `Cannot mark order as READY from ${current} status`);
        }

        const updated = await this.orderRepository.updateFulfillmentStatus(
          orderId,
          FulfillmentStatus.READY,
          undefined,
          tx,
          { fulfillmentStatus: current },
        );
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            statusDomain: OrderStatusDomain.FULFILLMENT as any,
            oldStatus: current,
            newStatus: FulfillmentStatus.READY,
            changedByUserId: actor.userId,
            reason: reason.trim(),
          },
        });
        return updated;
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order status changed concurrently");
      }
      throw error;
    }
  }

  /**
   * Delivers a READY order. Staff may deliver their own order; an OWNER acting
   * on another creator's order must provide a reason.
   */
  public async deliverOrder(
    orderId: string,
    reason: string | undefined,
    actor: AccessIdentity,
  ): Promise<Order> {
    if (reason !== undefined && typeof reason !== "string") {
      throw createHttpError(400, "reason must be a string when provided");
    }
    const normalizedReason = reason?.trim();

    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);
        assertOrderAccess(actor, order, "deliver");
        if (actor.role === "OWNER" && order.createdByUserId !== actor.userId && !normalizedReason) {
          throw createHttpError(400, "reason is required when an owner delivers another creator's order");
        }
        if (order.fulfillmentStatus !== FulfillmentStatus.READY) {
          throw createHttpError(409, `Cannot deliver an order in ${order.fulfillmentStatus} status. Order must be READY.`);
        }

        const updated = await this.orderRepository.updateFulfillmentStatus(
          orderId,
          FulfillmentStatus.DELIVERED,
          undefined,
          tx,
          { fulfillmentStatus: FulfillmentStatus.READY },
        );
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            statusDomain: OrderStatusDomain.FULFILLMENT as any,
            oldStatus: FulfillmentStatus.READY,
            newStatus: FulfillmentStatus.DELIVERED,
            changedByUserId: actor.userId,
            reason: normalizedReason || null,
          },
        });
        return updated;
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order status changed concurrently");
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Admin endpoints
  // ─────────────────────────────────────────────────────────────

  /**
   * Admin override: force-sets either `fulfillmentStatus` or `paymentStatus`
   * on a non-terminal order, bypassing normal transition rules.
   *
   * Blocked if:
   * - Overriding fulfillment on a DELIVERED or CANCELLED order.
   *
   * @param domain   - "FULFILLMENT" or "PAYMENT"
   * @param newStatus - The target status value.
   * @param adminId   - The admin's user ID.
   * @param reason    - Reason for the override.
   */
  public async overrideStatus(
    orderId:   string,
    domain:    OrderStatusDomain,
    newStatus: FulfillmentStatus | PaymentStatus,
    adminId:   string,
    reason?:   string
  ): Promise<Order> {
    try {
      return await this.runSerializable(async (tx) => {
        const order = await this.orderRepository.findById(orderId, tx);
        if (!order) throw createHttpError(404, `Order ${orderId} not found`);

        if (domain === OrderStatusDomain.FULFILLMENT) {
          const current = order.fulfillmentStatus;
          if (isFulfillmentTerminal(current)) {
            throw createHttpError(409, `Cannot override fulfillment status of an order in ${current} status (terminal).`);
          }
          const opts = newStatus === FulfillmentStatus.CANCELLED
            ? { cancellationReason: reason ?? "Admin override" }
            : undefined;
          const updated = await this.orderRepository.updateFulfillmentStatus(
            orderId,
            newStatus as FulfillmentStatus,
            opts,
            tx,
            { fulfillmentStatus: current },
          );
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              statusDomain: OrderStatusDomain.FULFILLMENT as any,
              oldStatus: current,
              newStatus: newStatus as string,
              changedByUserId: adminId,
              reason: reason ?? "Admin status override",
            },
          });
          return updated;
        }

        const current = order.paymentStatus;
        const opts = newStatus === PaymentStatus.PAID ? { paidAt: new Date() } : undefined;
        const updated = await this.orderRepository.updatePaymentStatus(
          orderId,
          newStatus as PaymentStatus,
          opts,
          tx,
          current,
        );
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            statusDomain: OrderStatusDomain.PAYMENT as any,
            oldStatus: current,
            newStatus: newStatus as string,
            changedByUserId: adminId,
            reason: reason ?? "Admin payment override",
          },
        });
        return updated;
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw createHttpError(409, "Order status changed concurrently");
      }
      throw error;
    }
  }
}
