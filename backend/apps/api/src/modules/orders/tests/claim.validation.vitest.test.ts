import { beforeEach, describe, expect, it, vi } from "vitest";

import { FulfillmentStatus, PaymentStatus } from "../order.types";
import type { AccessIdentity } from "../../auth/auth.types";

vi.mock("@prisma/client", () => {
  const prisma = {
    $transaction: vi.fn(),
    user: { findFirst: vi.fn() },
    orderStatusHistory: { create: vi.fn() },
  };

  return {
    PrismaClient: vi.fn().mockImplementation(() => prisma),
  };
});

import { PrismaClient } from "@prisma/client";

import { HistoryRepository } from "../../order-status-history/history.repository";
import { PaymentRepository } from "../../payments/payment.repository";
import { OrderRepository } from "../order.repository";
import { OrderService } from "../order.service";

describe("OrderService claim assignment validation", () => {
  const owner: AccessIdentity = {
    userId: "owner-1",
    sessionId: "owner-session",
    role: "OWNER",
  };
  let prisma: any;
  let historyRepository: { create: ReturnType<typeof vi.fn> };
  let orderRepository: {
    findById: ReturnType<typeof vi.fn>;
    updateFulfillmentStatus: ReturnType<typeof vi.fn>;
  };
  let service: OrderService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = new PrismaClient();
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
    historyRepository = { create: vi.fn().mockResolvedValue({}) };
    orderRepository = {
      findById: vi.fn().mockResolvedValue({
        id: "order-1",
        assignedBaristaId: null,
        paymentStatus: PaymentStatus.PAID,
        fulfillmentStatus: FulfillmentStatus.QUEUED,
      }),
      updateFulfillmentStatus: vi.fn().mockResolvedValue({
        id: "order-1",
        assignedBaristaId: "barista-1",
        fulfillmentStatus: FulfillmentStatus.PREPARING,
        items: [],
      }),
    };
    service = new OrderService(
      orderRepository as unknown as OrderRepository,
      historyRepository as unknown as HistoryRepository,
      {} as PaymentRepository,
    );
  });

  it("assigns an order only after finding an active BARISTA", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "barista-1" });
    await service.claimOrder("order-1", "barista-1", owner);

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: "barista-1",
        role: "BARISTA",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    expect(orderRepository.updateFulfillmentStatus).toHaveBeenCalledWith(
      "order-1",
      FulfillmentStatus.PREPARING,
      { assignedBaristaId: "barista-1" },
      prisma,
      {
        fulfillmentStatus: FulfillmentStatus.QUEUED,
        assignedBaristaId: null,
        paymentStatus: PaymentStatus.PAID,
      },
    );
    expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ changedByUserId: owner.userId }),
    });
  });

  it("rejects an owner, inactive Barista, or unknown user before updating the order", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.claimOrder("order-1", "owner-1", owner)).rejects.toMatchObject({
      statusCode: 400,
      message: "Orders can only be assigned to an active BARISTA user.",
    });

    expect(orderRepository.updateFulfillmentStatus).not.toHaveBeenCalled();
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(historyRepository.create).not.toHaveBeenCalled();
  });
});
