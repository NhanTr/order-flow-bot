import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessIdentity } from "../../auth/auth.types";
import { assertOrderAccess } from "../../auth/order-access.policy";
import { FulfillmentStatus, PaymentStatus } from "../order.types";
import { OrderController } from "../order.controller";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  menuItem: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  order: { update: vi.fn() },
  payment: { create: vi.fn() },
  orderStatusHistory: { create: vi.fn() },
}));

vi.mock("../../../db", () => ({ prisma: prismaMock }));

import { OrderService } from "../order.service";

const owner: AccessIdentity = { userId: "owner-1", sessionId: "owner-session", role: "OWNER" };
const staffA: AccessIdentity = { userId: "staff-a", sessionId: "staff-a-session", role: "SERVICE_STAFF" };
const staffB: AccessIdentity = { userId: "staff-b", sessionId: "staff-b-session", role: "SERVICE_STAFF" };
const barista: AccessIdentity = { userId: "barista-1", sessionId: "barista-session", role: "BARISTA" };

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    orderCode: "ORD-001",
    createdByUserId: "staff-a",
    assignedBaristaId: null,
    paymentStatus: PaymentStatus.UNPAID,
    fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
    totalAmount: 45_000n,
    items: [
      { id: "item-1", orderId: "order-1", menuItemId: "menu-1", itemName: "Coffee", unitPrice: 45_000n, quantity: 1 },
      { id: "item-2", orderId: "order-1", menuItemId: "menu-2", itemName: "Tea", unitPrice: 20_000n, quantity: 1 },
    ],
    ...overrides,
  } as any;
}

function buildService() {
  const orderRepository = {
    create: vi.fn(),
    findAll: vi.fn(),
    findById: vi.fn(),
    findItemById: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    updateFulfillmentStatus: vi.fn(),
    updatePaymentStatus: vi.fn(),
  };
  const historyRepository = { create: vi.fn() };
  const paymentRepository = { createForOrder: vi.fn() };

  return {
    service: new OrderService(orderRepository as any, historyRepository as any, paymentRepository as any),
    orderRepository,
    historyRepository,
    paymentRepository,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation((callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
});

describe("assertOrderAccess", () => {
  it("allows owners, limits staff to their own orders, and rejects baristas", () => {
    const staffOrder = { createdByUserId: staffA.userId };

    expect(() => assertOrderAccess(owner, staffOrder, "edit")).not.toThrow();
    expect(() => assertOrderAccess(staffA, staffOrder, "pay")).not.toThrow();
    expect(() => assertOrderAccess(staffB, staffOrder, "read")).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => assertOrderAccess(barista, staffOrder, "deliver")).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});

describe("OrderController verified actor forwarding", () => {
  it("ignores forged body identities for create, edit and cancel operations", async () => {
    const service = {
      createOrder: vi.fn().mockResolvedValue(order()),
      addItem: vi.fn().mockResolvedValue(order()),
      updateItem: vi.fn().mockResolvedValue(order()),
      deleteItem: vi.fn().mockResolvedValue(order()),
      cancelOrder: vi.fn().mockResolvedValue(order()),
    };
    const controller = new OrderController(service as unknown as OrderService);
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    const request = (
      body: Record<string, unknown>,
      params: Record<string, string> = { orderId: "order-1", itemId: "item-1" },
    ) => ({ body, params, auth: staffA }) as unknown as Request;

    await controller.createOrder(request({
      createdByUserId: owner.userId,
      items: [{ menuItemId: "menu-1", quantity: 1 }],
    }), response, next);
    await controller.addItem(request({
      requesterId: owner.userId,
      menuItemId: "menu-2",
      quantity: 1,
    }), response, next);
    await controller.updateItem(request({
      requesterId: owner.userId,
      quantity: 2,
    }), response, next);
    await controller.deleteItem(request({ requesterId: owner.userId }), response, next);
    await controller.cancelOrder(request({
      requesterId: owner.userId,
      reason: "Customer cancelled",
    }), response, next);

    expect(service.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: owner.userId }),
      staffA,
    );
    expect(service.addItem).toHaveBeenCalledWith(
      "order-1",
      expect.objectContaining({ requesterId: owner.userId }),
      staffA,
    );
    expect(service.updateItem).toHaveBeenCalledWith(
      "order-1",
      "item-1",
      expect.objectContaining({ requesterId: owner.userId }),
      staffA,
    );
    expect(service.deleteItem).toHaveBeenCalledWith("order-1", "item-1", staffA);
    expect(service.cancelOrder).toHaveBeenCalledWith("order-1", "Customer cancelled", staffA);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects non-string READY and delivery reasons before calling services", async () => {
    const service = {
      markReady: vi.fn(),
      deliverOrder: vi.fn(),
    };
    const controller = new OrderController(service as unknown as OrderService);
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    const request = {
      params: { orderId: "order-1" },
      body: { reason: { forged: true } },
      auth: owner,
    } as unknown as Request;

    await controller.markReady(request, response, next);
    await controller.deliverOrder(request, response, next);

    expect(response.status).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenNthCalledWith(1, 400);
    expect(response.status).toHaveBeenNthCalledWith(2, 400);
    expect(service.markReady).not.toHaveBeenCalled();
    expect(service.deliverOrder).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe("OrderService verified web actors", () => {
  it("server-scopes staff lists and returns 404 before ownership checks for unknown orders", async () => {
    const { service, orderRepository } = buildService();
    orderRepository.findAll.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

    await service.getOrders({ createdByUserId: staffB.userId, page: 2 }, staffA);

    expect(orderRepository.findAll).toHaveBeenCalledWith({
      createdByUserId: staffA.userId,
      page: 2,
    });

    orderRepository.findById.mockResolvedValue(null);
    await expect(service.getOrderById("unknown-order", staffA)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("blocks cross-order read, edit and cancel before any write", async () => {
    const { service, orderRepository, historyRepository } = buildService();
    orderRepository.findById.mockResolvedValue(order({ createdByUserId: staffB.userId }));

    await expect(service.getOrderById("order-1", staffA)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.addItem("order-1", { menuItemId: "menu-3", quantity: 1 }, staffA),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.updateItem("order-1", "item-1", { quantity: 2 }, staffA),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.deleteItem("order-1", "item-1", staffA))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.cancelOrder("order-1", "Forged cancellation", staffA))
      .rejects.toMatchObject({ statusCode: 403 });

    expect(prismaMock.menuItem.findUnique).not.toHaveBeenCalled();
    expect(orderRepository.addItem).not.toHaveBeenCalled();
    expect(orderRepository.updateItem).not.toHaveBeenCalled();
    expect(orderRepository.deleteItem).not.toHaveBeenCalled();
    expect(orderRepository.updateFulfillmentStatus).not.toHaveBeenCalled();
    expect(historyRepository.create).not.toHaveBeenCalled();
  });

  it("ignores a forged creator id and attributes creation to the authenticated staff member", async () => {
    const { service, orderRepository, historyRepository, paymentRepository } = buildService();
    prismaMock.menuItem.findUnique.mockResolvedValue({
      id: "menu-1",
      name: "Coffee",
      price: 45_000n,
      isAvailable: true,
      category: { name: "Coffee", isActive: true },
    });
    orderRepository.create.mockResolvedValue(order());

    await service.createOrder({
      createdByUserId: owner.userId,
      items: [{ menuItemId: "menu-1", quantity: 1 }],
    }, staffA);

    expect(orderRepository.create).toHaveBeenCalledWith(
      staffA.userId,
      undefined,
      undefined,
      [expect.objectContaining({ menuItemId: "menu-1", unitPrice: 45_000n })],
      prismaMock,
    );
    expect(prismaMock.payment.create).toHaveBeenCalled();
    expect(prismaMock.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ changedByUserId: staffA.userId }),
    });

    await expect(service.createOrder({
      createdByUserId: owner.userId,
      items: [{ menuItemId: "menu-1", quantity: 1 }],
    }, barista)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("restarts the whole create transaction for an order-code collision", async () => {
    const { service, orderRepository } = buildService();
    const menuItem = {
      id: "menu-1",
      name: "Coffee",
      price: 45_000n,
      isAvailable: true,
      category: { name: "Coffee", isActive: true },
    };
    const firstTx = {
      menuItem: { findUnique: vi.fn().mockResolvedValue(menuItem) },
      payment: { create: vi.fn() },
      orderStatusHistory: { create: vi.fn() },
    };
    const secondTx = {
      menuItem: { findUnique: vi.fn().mockResolvedValue(menuItem) },
      payment: { create: vi.fn().mockResolvedValue({ id: "payment-2" }) },
      orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    };
    prismaMock.$transaction
      .mockImplementationOnce((callback: (tx: typeof firstTx) => unknown) => callback(firstTx))
      .mockImplementationOnce((callback: (tx: typeof secondTx) => unknown) => callback(secondTx));
    orderRepository.create
      .mockRejectedValueOnce(Object.assign(new Error("order code collision"), {
        code: "P2002",
        meta: { target: ["order_code"] },
      }))
      .mockResolvedValueOnce(order());

    await service.createOrder({
      createdByUserId: owner.userId,
      items: [{ menuItemId: "menu-1", quantity: 1 }],
    }, staffA);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(orderRepository.create).toHaveBeenNthCalledWith(
      1, staffA.userId, undefined, undefined, expect.any(Array), firstTx,
    );
    expect(orderRepository.create).toHaveBeenNthCalledWith(
      2, staffA.userId, undefined, undefined, expect.any(Array), secondTx,
    );
    expect(firstTx.payment.create).not.toHaveBeenCalled();
    expect(secondTx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it("restarts for payment-code collisions but not unrelated unique errors", async () => {
    const { service, orderRepository } = buildService();
    const menuItem = {
      id: "menu-1",
      name: "Coffee",
      price: 45_000n,
      isAvailable: true,
      category: { name: "Coffee", isActive: true },
    };
    const firstTx = {
      menuItem: { findUnique: vi.fn().mockResolvedValue(menuItem) },
      payment: { create: vi.fn().mockRejectedValue(Object.assign(new Error("payment code collision"), {
        code: "P2002",
        meta: { target: ["payment_code"] },
      })) },
      orderStatusHistory: { create: vi.fn() },
    };
    const secondTx = {
      menuItem: { findUnique: vi.fn().mockResolvedValue(menuItem) },
      payment: { create: vi.fn().mockResolvedValue({ id: "payment-2" }) },
      orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    };
    prismaMock.$transaction
      .mockImplementationOnce((callback: (tx: typeof firstTx) => unknown) => callback(firstTx))
      .mockImplementationOnce((callback: (tx: typeof secondTx) => unknown) => callback(secondTx));
    orderRepository.create.mockResolvedValue(order());

    await service.createOrder({
      createdByUserId: owner.userId,
      items: [{ menuItemId: "menu-1", quantity: 1 }],
    }, staffA);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(orderRepository.create).toHaveBeenNthCalledWith(
      1, staffA.userId, undefined, undefined, expect.any(Array), firstTx,
    );
    expect(orderRepository.create).toHaveBeenNthCalledWith(
      2, staffA.userId, undefined, undefined, expect.any(Array), secondTx,
    );
    expect(firstTx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(secondTx.orderStatusHistory.create).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const unrelatedUniqueError = Object.assign(new Error("unrelated unique constraint"), {
      code: "P2002",
      meta: { target: ["order_id"] },
    });
    const unrelatedTx = {
      menuItem: { findUnique: vi.fn().mockResolvedValue(menuItem) },
      payment: { create: vi.fn().mockRejectedValue(unrelatedUniqueError) },
      orderStatusHistory: { create: vi.fn() },
    };
    prismaMock.$transaction.mockImplementation(
      (callback: (tx: typeof unrelatedTx) => unknown) => callback(unrelatedTx),
    );
    orderRepository.create.mockResolvedValue(order());

    await expect(service.createOrder({
      createdByUserId: owner.userId,
      items: [{ menuItemId: "menu-1", quantity: 1 }],
    }, staffA)).rejects.toBe(unrelatedUniqueError);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(orderRepository.create).toHaveBeenCalledTimes(1);
  });

  it("records the owner as actor and the active barista only as assignee", async () => {
    const { service, orderRepository, historyRepository } = buildService();
    orderRepository.findById.mockResolvedValue(order({
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.QUEUED,
    }));
    prismaMock.user.findFirst.mockResolvedValue({ id: barista.userId });
    orderRepository.updateFulfillmentStatus.mockResolvedValue(order({
      assignedBaristaId: barista.userId,
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.PREPARING,
    }));

    await service.claimOrder("order-1", barista.userId, owner);

    expect(orderRepository.updateFulfillmentStatus).toHaveBeenCalledWith(
      "order-1",
      FulfillmentStatus.PREPARING,
      { assignedBaristaId: barista.userId },
      prismaMock,
      expect.objectContaining({ assignedBaristaId: null }),
    );
    expect(prismaMock.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ changedByUserId: owner.userId }),
    });

    await expect(service.claimOrder("order-1", barista.userId, staffA))
      .rejects.toMatchObject({ statusCode: 403 });

    orderRepository.findById.mockResolvedValue(null);
    await expect(service.claimOrder("unknown-order", barista.userId, owner))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("requires an owner reason for web READY and restricts delivery to owner or owning staff", async () => {
    const { service, orderRepository, historyRepository } = buildService();
    orderRepository.findById.mockResolvedValue(order({
      createdByUserId: staffB.userId,
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.PREPARING,
      assignedBaristaId: barista.userId,
    }));
    orderRepository.updateFulfillmentStatus.mockResolvedValue(order());

    await expect(service.markReady("order-1", {} as any, owner))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.markReady("order-1", "", owner)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.markReady("order-1", "Forged", staffA)).rejects.toMatchObject({ statusCode: 403 });
    await service.markReady("order-1", "Owner override", owner);
    expect(prismaMock.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ changedByUserId: owner.userId, reason: "Owner override" }),
    });

    orderRepository.findById.mockResolvedValue(order({
      createdByUserId: staffA.userId,
      fulfillmentStatus: FulfillmentStatus.READY,
    }));
    await expect(service.deliverOrder("order-1", {} as any, staffA))
      .rejects.toMatchObject({ statusCode: 400 });
    await service.deliverOrder("order-1", undefined, staffA);

    orderRepository.findById.mockResolvedValue(order({
      createdByUserId: staffB.userId,
      fulfillmentStatus: FulfillmentStatus.READY,
    }));
    await expect(service.deliverOrder("order-1", undefined, staffA))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.deliverOrder("order-1", undefined, owner))
      .rejects.toMatchObject({ statusCode: 400 });
    await service.deliverOrder("order-1", "Owner delivered another staff order", owner);
  });
});
