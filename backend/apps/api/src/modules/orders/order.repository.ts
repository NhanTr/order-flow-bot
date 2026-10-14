import { Prisma } from "@prisma/client";
import {
  Order,
  OrderItem,
  CreateOrderInput,
  AddItemInput,
  UpdateItemInput,
  OrderFilters,
  PaginatedResult,
  FulfillmentStatus,
  PaymentStatus,
} from "./order.types";
import { calculateTotal } from "./order-total";
import { generateOrderCode } from "./order-code";
import { prisma } from "../../db";

/** Include clause used consistently across all order queries. */
const ORDER_INCLUDE = { items: true } as const;
const ORDER_DETAIL_INCLUDE = { items: true, history: { orderBy: { createdAt: "asc" } } } as const;
const ORDER_CODE_MAX_ATTEMPTS = 5;
type OrderDatabase = Prisma.TransactionClient | typeof prisma;

function toOrderWithTimeline(order: unknown): Order {
  const data = order as any;
  if (data.history !== undefined) {
    data.timeline = data.history;
    delete data.history;
  }
  return data as Order;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string }).code === "P2002";
}

/**
 * Repository for all `orders` and `order_items` database operations.
 * No business logic — only Prisma queries.
 */
export class OrderRepository {
  /**
   * Creates an order + items in a single transaction.
   * Generates an `orderCode` and computes `totalAmount`.
   */
  public async create(
    createdByUserId: string,
    paymentMethod:   any,
    customerNote:    string | undefined,
    items:           Array<{ menuItemId: string; itemName: string; unitPrice: bigint; quantity: number; note?: string }>,
    database:        OrderDatabase = prisma,
  ): Promise<Order> {
    const totalAmount = calculateTotal(items);
    const maxAttempts = database === prisma ? ORDER_CODE_MAX_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const orderCode = generateOrderCode();

      try {
        const order = await database.order.create({
          data: {
            orderCode,
            createdByUserId,
            paymentMethod,
            customerNote,
            totalAmount,
            items: {
              create: items.map((item) => ({
                menuItemId: item.menuItemId,
                itemName:   item.itemName,
                unitPrice:  item.unitPrice,
                quantity:   item.quantity,
                note:       item.note,
              })),
            },
          },
          include: ORDER_INCLUDE,
        });

        return order as unknown as Order;
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw new Error("Unable to generate a unique order code");
  }

  /**
   * Finds an order by ID with its items.
   */
  public async findById(id: string, database: OrderDatabase = prisma): Promise<Order | null> {
    const order = await database.order.findUnique({
      where: { id },
      include: ORDER_DETAIL_INCLUDE,
    });
    return order ? toOrderWithTimeline(order) : null;
  }

  /**
   * Returns a paginated, filtered list of orders.
   */
  public async findAll(filters: OrderFilters = {}): Promise<PaginatedResult<Order>> {
    const {
      fulfillmentStatus,
      paymentStatus,
      createdByUserId,
      assignedBaristaId,
      page  = 1,
      limit = 20,
    } = filters;

    const skip = (page - 1) * limit;

    const where: any = {};
    if (fulfillmentStatus) where.fulfillmentStatus = fulfillmentStatus;
    if (paymentStatus)     where.paymentStatus     = paymentStatus;
    if (createdByUserId)   where.createdByUserId   = createdByUserId;
    if (assignedBaristaId) where.assignedBaristaId = assignedBaristaId;

    const [data, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        skip,
        take:    limit,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: "desc" },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      data: data as unknown as Order[],
      total,
      page,
      limit,
    };
  }

  /**
   * Updates the `fulfillmentStatus` of an order, optionally assigning a barista.
   */
  public async updateFulfillmentStatus(
    id:                string,
    fulfillmentStatus: FulfillmentStatus,
    opts?: {
      assignedBaristaId?: string;
      cancellationReason?: string;
    },
    database: OrderDatabase = prisma,
    expected?: {
      fulfillmentStatus?: FulfillmentStatus;
      paymentStatus?: PaymentStatus;
      assignedBaristaId?: string | null;
    },
  ): Promise<Order> {
    const data: any = { fulfillmentStatus };
    if (opts?.assignedBaristaId  !== undefined) data.assignedBaristaId  = opts.assignedBaristaId;
    if (opts?.cancellationReason !== undefined) data.cancellationReason = opts.cancellationReason;

    if (expected) {
      const updated = await database.order.updateMany({
        where: { id, ...expected } as any,
        data,
      });
      if (updated.count !== 1) {
        const error = new Error("Order status changed concurrently") as Error & { code?: string };
        error.code = "P2025";
        throw error;
      }
    } else {
      await database.order.update({ where: { id }, data });
    }

    const order = await database.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    return order as unknown as Order;
  }

  /**
   * Updates the `paymentStatus` of an order.
   * Optionally sets `paidAt` when transitioning to PAID.
   */
  public async updatePaymentStatus(
    id:            string,
    paymentStatus: PaymentStatus,
    opts?: { paidAt?: Date },
    database: OrderDatabase = prisma,
    expectedPaymentStatus?: PaymentStatus,
  ): Promise<Order> {
    const data: any = { paymentStatus };
    if (opts?.paidAt !== undefined) data.paidAt = opts.paidAt;

    if (expectedPaymentStatus) {
      const updated = await database.order.updateMany({
        where: { id, paymentStatus: expectedPaymentStatus as any },
        data,
      });
      if (updated.count !== 1) {
        const error = new Error("Order payment status changed concurrently") as Error & { code?: string };
        error.code = "P2025";
        throw error;
      }
    } else {
      await database.order.update({ where: { id }, data });
    }

    const order = await database.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    return order as unknown as Order;
  }

  /**
   * Adds an item to an order and recalculates `totalAmount` — inside a transaction.
   */
  public async addItem(
    orderId: string,
    item:    { menuItemId: string; itemName: string; unitPrice: bigint; quantity: number; note?: string },
    database: OrderDatabase = prisma,
  ): Promise<Order> {
    const execute = async (tx: Prisma.TransactionClient) => {
      await tx.orderItem.create({
        data: {
          orderId,
          menuItemId: item.menuItemId,
          itemName:   item.itemName,
          unitPrice:  item.unitPrice,
          quantity:   item.quantity,
          note:       item.note,
        },
      });

      const allItems = await tx.orderItem.findMany({ where: { orderId } });
      const newTotal = calculateTotal(allItems);

      const updatedCount = await tx.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: PaymentStatus.UNPAID as any,
          fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT as any,
        },
        data: { totalAmount: newTotal },
      });
      if (updatedCount.count !== 1) {
        const error = new Error("Order is no longer editable") as Error & { code?: string };
        error.code = "P2025";
        throw error;
      }
      await tx.payment.updateMany({
        where: { orderId, confirmedAt: null, receivedAmount: BigInt(0) },
        data: { expectedAmount: newTotal },
      });
      const updated = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      return updated as unknown as Order;
    };

    return database === prisma
      ? prisma.$transaction(execute)
      : execute(database as Prisma.TransactionClient);
  }

  /**
   * Updates an order item and recalculates `totalAmount` — inside a transaction.
   */
  public async updateItem(
    orderId: string,
    itemId:  string,
    input:   UpdateItemInput,
    database: OrderDatabase = prisma,
  ): Promise<Order> {
    const execute = async (tx: Prisma.TransactionClient) => {
      const existing = await tx.orderItem.findFirst({ where: { id: itemId, orderId } });
      if (!existing) {
        throw new Error(`Item ${itemId} not found in order ${orderId}`);
      }

      const patch: any = {};
      if (input.quantity !== undefined) patch.quantity = input.quantity;
      if (input.note     !== undefined) patch.note     = input.note;

      await tx.orderItem.update({ where: { id: itemId }, data: patch });

      const allItems = await tx.orderItem.findMany({ where: { orderId } });
      const newTotal = calculateTotal(allItems);

      const updatedCount = await tx.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: PaymentStatus.UNPAID as any,
          fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT as any,
        },
        data: { totalAmount: newTotal },
      });
      if (updatedCount.count !== 1) {
        const error = new Error("Order is no longer editable") as Error & { code?: string };
        error.code = "P2025";
        throw error;
      }
      await tx.payment.updateMany({
        where: { orderId, confirmedAt: null, receivedAmount: BigInt(0) },
        data: { expectedAmount: newTotal },
      });
      const updated = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      return updated as unknown as Order;
    };

    return database === prisma
      ? prisma.$transaction(execute)
      : execute(database as Prisma.TransactionClient);
  }

  /**
   * Deletes an order item and recalculates `totalAmount` — inside a transaction.
   */
  public async deleteItem(
    orderId: string,
    itemId: string,
    database: OrderDatabase = prisma,
  ): Promise<Order> {
    const execute = async (tx: Prisma.TransactionClient) => {
      const existing = await tx.orderItem.findFirst({ where: { id: itemId, orderId } });
      if (!existing) {
        throw new Error(`Item ${itemId} not found in order ${orderId}`);
      }

      await tx.orderItem.delete({ where: { id: itemId } });

      const remaining = await tx.orderItem.findMany({ where: { orderId } });
      const newTotal  = calculateTotal(remaining);

      const updatedCount = await tx.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: PaymentStatus.UNPAID as any,
          fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT as any,
        },
        data: { totalAmount: newTotal },
      });
      if (updatedCount.count !== 1) {
        const error = new Error("Order is no longer editable") as Error & { code?: string };
        error.code = "P2025";
        throw error;
      }
      await tx.payment.updateMany({
        where: { orderId, confirmedAt: null, receivedAmount: BigInt(0) },
        data: { expectedAmount: newTotal },
      });
      const updated = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      return updated as unknown as Order;
    };

    return database === prisma
      ? prisma.$transaction(execute)
      : execute(database as Prisma.TransactionClient);
  }

  /**
   * Looks up a specific item that belongs to the given order.
   */
  public async findItemById(
    orderId: string,
    itemId: string,
    database: OrderDatabase = prisma,
  ): Promise<OrderItem | null> {
    const item = await database.orderItem.findFirst({
      where: { id: itemId, orderId },
    });
    return item as unknown as OrderItem | null;
  }
}
