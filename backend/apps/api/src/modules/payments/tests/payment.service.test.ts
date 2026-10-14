import { describe, expect, it, vi } from "vitest";

import type { AccessIdentity } from "../../auth/auth.types";
import { FulfillmentStatus, PaymentStatus } from "../../orders/order.types";
import { PaymentService } from "../payment.service";

const tx = vi.hoisted(() => ({
  order: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },

  payment: {
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  orderStatusHistory: {
    create: vi.fn(),
    createMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
}));

vi.mock("@prisma/client", () => ({
  AuditEntityType: {
    PAYMENT: "PAYMENT",
  },
  PrismaClient: vi.fn(function PrismaClientMock() {
    return {
    $transaction: vi.fn((callback) => callback(tx)),
    order: {
      findUnique: vi.fn(),
    },
    };
  }),
}));

describe("PaymentService financial audit", () => {
  const staff: AccessIdentity = {
    userId: "staff-1",
    sessionId: "staff-session",
    role: "SERVICE_STAFF",
  };

  it("records an audit log when confirming cash payment", async () => {
    vi.clearAllMocks();
    tx.order.findUnique.mockResolvedValue({
      id: "order-1",
      orderCode: "ORD-CASH-1",
      createdByUserId: "staff-1",
      paymentStatus: PaymentStatus.UNPAID,
      fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
      totalAmount: 45000n,
      payment: {
        id: "payment-1",
        receivedAmount: 0n,
        confirmedAt: null,
      },
    });
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.orderStatusHistory.createMany.mockResolvedValue({ count: 2 });
    tx.payment.findUnique.mockResolvedValue({ id: "payment-1", receivedAmount: 45000n });

    await new PaymentService({} as any).confirmCash("order-1", {
      confirmedByUserId: "staff-1",
    }, staff);

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "staff-1",
        action: "CASH_PAYMENT_CONFIRMED",
        entityType: "PAYMENT",
        entityId: "payment-1",
        details: expect.objectContaining({
          orderCode: "ORD-CASH-1",
          amount: "45000",
          newPaymentStatus: PaymentStatus.PAID,
          newFulfillmentStatus: FulfillmentStatus.QUEUED,
        }),
      }),
    });
  });

  it("records an audit log when initializing QR payment", async () => {
    vi.clearAllMocks();
    tx.order.findUnique.mockResolvedValue({
      id: "order-1",
      orderCode: "ORD-QR-1",
      createdByUserId: "staff-1",
      paymentStatus: PaymentStatus.UNPAID,
      fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
      totalAmount: 55000n,
      payment: null,
    });
    tx.payment.create.mockResolvedValue({
      id: "payment-qr-1",
      paymentCode: "PAYORDQR1",
      expectedAmount: 55000n,
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.orderStatusHistory.create.mockResolvedValue({});

    await new PaymentService({} as any).initQrPayment("order-1", {
      requestedByUserId: "staff-1",
    }, staff);

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "staff-1",
        action: "QR_PAYMENT_INITIALIZED",
        entityType: "PAYMENT",
        entityId: "payment-qr-1",
        details: expect.objectContaining({
          orderCode: "ORD-QR-1",
          expectedAmount: "55000",
          newPaymentStatus: PaymentStatus.PENDING,
        }),
      }),
    });
  });
});
