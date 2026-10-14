import type { NextFunction, Request, Response } from "express";
import { ResolutionAction } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessIdentity } from "../../auth/auth.types";
import { FulfillmentStatus, PaymentStatus } from "../../orders/order.types";

const tx = vi.hoisted(() => ({
  order: { findUnique: vi.fn(), updateMany: vi.fn() },
  payment: {
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  orderStatusHistory: { create: vi.fn(), createMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const prismaMock = vi.hoisted(() => ({
  order: { findUnique: vi.fn() },
  $transaction: vi.fn((callback) => callback(tx)),
}));

vi.mock("../../../db", () => ({ prisma: prismaMock }));

import { PaymentController } from "../payment.controller";
import { PaymentService } from "../payment.service";
import { RefundController } from "../../refunds/refund.controller";
import { ReconciliationController } from "../../reconciliations/reconciliation.controller";

const owner: AccessIdentity = { userId: "owner-1", sessionId: "owner-session", role: "OWNER" };
const staffA: AccessIdentity = { userId: "staff-a", sessionId: "staff-a-session", role: "SERVICE_STAFF" };
const staffB: AccessIdentity = { userId: "staff-b", sessionId: "staff-b-session", role: "SERVICE_STAFF" };
const barista: AccessIdentity = { userId: "barista-1", sessionId: "barista-session", role: "BARISTA" };

function responseMock(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function request(
  auth: AccessIdentity | undefined,
  body: Record<string, unknown> = {},
): Request<{ orderId: string }> {
  return {
    params: { orderId: "order-1", reconciliationId: "reconciliation-1" },
    body,
    auth,
  } as unknown as Request<{ orderId: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation((callback) => callback(tx));
});

describe("PaymentController verified actor forwarding", () => {
  it("ignores legacy cash and QR actor fields", async () => {
    const paymentService = {
      confirmCash: vi.fn().mockResolvedValue({ id: "payment-1" }),
      initQrPayment: vi.fn().mockResolvedValue({ payment: { id: "payment-1" } }),
    };
    const controller = new PaymentController(paymentService as unknown as PaymentService);
    const response = responseMock();
    const next = vi.fn() as NextFunction;

    await controller.confirmCash(
      request(staffA, { confirmedByUserId: owner.userId, amount: 45_000 }),
      response,
      next,
    );
    await controller.initQrPayment(
      request(staffA, { requestedByUserId: owner.userId }),
      response,
      next,
    );

    expect(paymentService.confirmCash).toHaveBeenCalledWith(
      "order-1",
      { confirmedByUserId: owner.userId, amount: 45_000 },
      staffA,
    );
    expect(paymentService.initQrPayment).toHaveBeenCalledWith(
      "order-1",
      { requestedByUserId: owner.userId },
      staffA,
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe("PaymentService ownership and attribution", () => {
  function unpaidOrder(createdByUserId: string) {
    return {
      id: "order-1",
      orderCode: "ORD-001",
      createdByUserId,
      paymentStatus: PaymentStatus.UNPAID,
      fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
      totalAmount: 45_000n,
      payment: { id: "payment-1", receivedAmount: 0n, confirmedAt: null },
    };
  }

  it("limits payment reads to owners and the staff order creator", async () => {
    const paymentRepository = { findManyByOrderId: vi.fn().mockResolvedValue([]) };
    const service = new PaymentService(paymentRepository as any);
    prismaMock.order.findUnique.mockResolvedValue(unpaidOrder(staffB.userId));

    await expect(service.listOrderPayments("order-1", staffA))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.listOrderPayments("order-1", barista))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(paymentRepository.findManyByOrderId).not.toHaveBeenCalled();

    await service.listOrderPayments("order-1", staffB);
    await service.listOrderPayments("order-1", owner);
    expect(paymentRepository.findManyByOrderId).toHaveBeenCalledTimes(2);
  });

  it("rejects forged cross-order cash actors with zero writes", async () => {
    tx.order.findUnique.mockResolvedValue(unpaidOrder(staffB.userId));

    await expect(new PaymentService({} as any).confirmCash(
      "order-1",
      { confirmedByUserId: owner.userId },
      staffA,
    )).rejects.toMatchObject({ statusCode: 403 });

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects forged cross-order QR actors with zero writes", async () => {
    tx.order.findUnique.mockResolvedValue(unpaidOrder(staffB.userId));

    await expect(new PaymentService({} as any).initQrPayment(
      "order-1",
      { requestedByUserId: owner.userId },
      staffA,
    )).rejects.toMatchObject({ statusCode: 403 });

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("attributes valid own-order cash confirmation to authenticated staff", async () => {
    tx.order.findUnique.mockResolvedValue(unpaidOrder(staffA.userId));
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.orderStatusHistory.createMany.mockResolvedValue({ count: 2 });
    tx.payment.findUnique.mockResolvedValue({ id: "payment-1", receivedAmount: 45_000n });

    await new PaymentService({} as any).confirmCash(
      "order-1",
      { confirmedByUserId: owner.userId },
      staffA,
    );

    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ cashConfirmedByUserId: staffA.userId }),
    }));
    expect(tx.orderStatusHistory.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ changedByUserId: staffA.userId }),
      ]),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: staffA.userId }),
    });
  });

  it("returns 404 for an unknown order and allows owners to pay any known order", async () => {
    tx.order.findUnique.mockResolvedValueOnce(null);
    await expect(new PaymentService({} as any).initQrPayment(
      "unknown-order",
      { requestedByUserId: staffA.userId },
      staffA,
    )).rejects.toMatchObject({ statusCode: 404 });

    tx.order.findUnique.mockResolvedValueOnce(unpaidOrder(staffB.userId));
    tx.payment.update.mockResolvedValue({
      id: "payment-1",
      paymentCode: "PAY001",
      expectedAmount: 45_000n,
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.orderStatusHistory.create.mockResolvedValue({});

    await expect(new PaymentService({} as any).initQrPayment(
      "order-1",
      { requestedByUserId: staffA.userId },
      owner,
    )).resolves.toMatchObject({ amount: 45_000n });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: owner.userId }),
    });
  });
});

describe("owner-only refund and reconciliation attribution", () => {
  it("rejects staff before refund or reconciliation writes", async () => {
    const refundService = { refundOrder: vi.fn() };
    const reconciliationService = { resolveReconciliation: vi.fn() };
    const response = responseMock();
    const refundNext = vi.fn() as NextFunction;
    const reconciliationNext = vi.fn() as NextFunction;

    await new RefundController(refundService as any).refundOrder(
      request(staffA, { refundedByUserId: owner.userId, reason: "Forged owner" }),
      response,
      refundNext,
    );
    await new ReconciliationController(reconciliationService as any).resolveReconciliation(
      request(staffA, {
        resolvedByUserId: owner.userId,
        resolutionAction: ResolutionAction.ACCEPT,
        resolutionNote: "Forged owner",
      }) as any,
      response,
      reconciliationNext,
    );

    expect(refundService.refundOrder).not.toHaveBeenCalled();
    expect(reconciliationService.resolveReconciliation).not.toHaveBeenCalled();
    expect(refundNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(reconciliationNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("forces the authenticated owner id and ignores legacy actor fields", async () => {
    const refundService = { refundOrder: vi.fn().mockResolvedValue({ ok: true }) };
    const reconciliationService = { resolveReconciliation: vi.fn().mockResolvedValue({ ok: true }) };
    const response = responseMock();
    const next = vi.fn() as NextFunction;

    await new RefundController(refundService as any).refundOrder(
      request(owner, { refundedByUserId: staffA.userId, reason: "Approved" }),
      response,
      next,
    );
    await new ReconciliationController(reconciliationService as any).resolveReconciliation(
      request(owner, {
        resolvedByUserId: staffA.userId,
        resolutionAction: ResolutionAction.ACCEPT,
        resolutionNote: "Approved",
      }) as any,
      response,
      next,
    );

    expect(refundService.refundOrder).toHaveBeenCalledWith("order-1", {
      refundedByUserId: owner.userId,
      reason: "Approved",
    });
    expect(reconciliationService.resolveReconciliation).toHaveBeenCalledWith(
      "reconciliation-1",
      {
        resolvedByUserId: owner.userId,
        resolutionAction: ResolutionAction.ACCEPT,
        resolutionNote: "Approved",
      },
    );
  });
});
