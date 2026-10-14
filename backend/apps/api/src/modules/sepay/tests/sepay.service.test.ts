import { TransactionMatchStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FulfillmentStatus, PaymentMethod, PaymentStatus } from "../../orders/order.types";
import { SepayService } from "../sepay.service";

function buildCandidate(amount = BigInt(100000), overrides: any = {}) {
  return {
    id: "payment-1",
    orderId: "order-1",
    paymentCode: "PAY-TEST-001",
    expectedAmount: amount,
    order: {
      id: "order-1",
      orderCode: "ORDER-001",
      paymentMethod: PaymentMethod.QR,
      paymentStatus: PaymentStatus.PENDING,
      fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
      ...overrides.order,
    },
    ...overrides.payment,
  };
}

function webhook(overrides: Record<string, unknown>) {
  return {
    id: "99007001",
    transactionDate: "2026-08-10 21:00:00",
    accountNumber: "1017588888",
    content: "PAY-TEST-001",
    transferType: "in",
    transferAmount: 100_000,
    ...overrides,
  };
}

function buildTx(candidate: any | null, existingTransaction: any | null = null) {
  return {
    sepayTransaction: {
      findUnique: vi.fn().mockResolvedValue(existingTransaction),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "transaction-1",
        paymentId: data.paymentId,
        matchStatus: data.matchStatus,
      })),
    },
    payment: {
      findFirst: vi.fn().mockResolvedValue(candidate),
      findMany: vi.fn().mockResolvedValue(candidate ? [candidate] : []),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(candidate ? {
        id: candidate.orderId,
        orderCode: candidate.order.orderCode,
        totalAmount: candidate.expectedAmount,
        paymentMethod: candidate.order.paymentMethod,
        createdByUserId: "staff-1",
        creator: { telegramChatId: 100n, telegramUserId: 99n },
        items: [{ itemName: "Trà đào", quantity: 2, note: null }],
      } : null),
    },
    orderStatusHistory: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findMany: vi.fn().mockImplementation(async ({ where }) => where.role === "BARISTA"
        ? [{ id: "barista-1", telegramChatId: 123n, telegramUserId: null }]
        : [{ id: "owner-1", telegramChatId: 200n, telegramUserId: 201n }]),
    },
    notification: {
      upsert: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

function buildService(tx: any) {
  const db = {
    $transaction: vi.fn((callback) => callback(tx)),
  };

  return new SepayService(db as any);
}

describe("SepayService", () => {
  beforeEach(() => {
    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "test-webhook-key");
    vi.stubEnv("SEPAY_BANK_ACCOUNT", "1017588888");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("marks exact QR payments as PAID and QUEUED", async () => {
    const tx = buildTx(buildCandidate());
    const result = await buildService(tx).handleWebhook(
      webhook({ id: "99007001", content: "Transfer PAY-TEST-001" }),
      { authorization: "Apikey test-webhook-key" }
    );

    expect(result).toMatchObject({
      duplicate: false,
      matched: true,
      paymentId: "payment-1",
      matchStatus: TransactionMatchStatus.MATCHED,
    });
    expect(tx.payment.findFirst).not.toHaveBeenCalled();
    expect(tx.payment.findMany).toHaveBeenCalledWith({
      where: { paymentCode: { in: expect.arrayContaining(["PAY-TEST-001"]) } },
      include: { order: true },
      take: 2,
    });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "order-1",
        paymentMethod: PaymentMethod.QR,
        paymentStatus: PaymentStatus.PENDING,
        fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
      }),
      data: {
        paymentStatus: PaymentStatus.PAID,
        fulfillmentStatus: FulfillmentStatus.QUEUED,
        paidAt: expect.any(Date),
      },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ recipientUserId: "barista-1", event: "ORDER_PAID" })],
      skipDuplicates: true,
    }));
    expect(tx.notification.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ event: "ORDER_PAID", recipientUserId: "staff-1" }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "SEPAY_WEBHOOK_MATCHED" }),
    }));
  });

  it("accepts the official SePay Apikey authorization header", async () => {
    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "live-webhook-key");
    const tx = buildTx(null);

    await expect(buildService(tx).handleWebhook({
      id: 92704,
      gateway: "Vietcombank",
      transactionDate: "2026-08-10 21:00:00",
      accountNumber: "1017588888",
      code: "UNKNOWN",
      content: "UNKNOWN chuyen tien",
      transferType: "in",
      transferAmount: 10_000,
      referenceCode: "FT24012345678",
    }, { authorization: "Apikey live-webhook-key" })).resolves.toMatchObject({
      duplicate: false,
      matched: false,
      matchStatus: TransactionMatchStatus.WRONG_CODE,
    });
  });

  it("rejects an invalid API key and fails closed in production when no key is configured", async () => {
    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "live-webhook-key");
    await expect(buildService(buildTx(null)).handleWebhook(
      { id: 92705, transferAmount: 10_000, content: "UNKNOWN" },
      { authorization: "Apikey wrong-key" },
    )).rejects.toMatchObject({ statusCode: 401 });

    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "");
    vi.stubEnv("SEPAY_WEBHOOK_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    await expect(buildService(buildTx(null)).handleWebhook(
      { id: 92706, transferAmount: 10_000, content: "UNKNOWN" },
      {},
    )).rejects.toMatchObject({ statusCode: 503 });
  });

  it.each(["development", "test", "production"])(
    "fails closed before parsing or database work when the webhook key is missing in %s",
    async (nodeEnv) => {
      vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "");
      vi.stubEnv("SEPAY_WEBHOOK_SECRET", "");
      vi.stubEnv("NODE_ENV", nodeEnv);
      const tx = buildTx(null);

      await expect(buildService(tx).handleWebhook({ transferAmount: "not-an-amount" }, {}))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(tx.sepayTransaction.findUnique).not.toHaveBeenCalled();
    },
  );

  it("rejects a bad key before parsing malformed business data", async () => {
    const tx = buildTx(null);

    await expect(buildService(tx).handleWebhook(
      { transferAmount: Number.MAX_SAFE_INTEGER + 1 },
      { authorization: "Apikey wrong-key" },
    )).rejects.toMatchObject({ statusCode: 401 });
    expect(tx.sepayTransaction.findUnique).not.toHaveBeenCalled();
  });

  it("normalizes official webhook fields without losing a numeric transaction ID", async () => {
    const tx = buildTx(buildCandidate());

    await buildService(tx).handleWebhook({
      id: 92704,
      gateway: "Vietcombank",
      transactionDate: "2026-08-10 21:00:00",
      accountNumber: "1017588888",
      code: "PAY-TEST-001",
      content: "PAY-TEST-001 chuyen tien",
      transferType: "in",
      transferAmount: 100_000,
      referenceCode: "FT24012345678",
    }, { authorization: "Apikey test-webhook-key" });

    expect(tx.sepayTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sepayTransactionId: "92704",
        amountIn: 100_000n,
        transactionDate: new Date("2026-08-10T14:00:00.000Z"),
        code: "PAY-TEST-001",
        referenceCode: "FT24012345678",
      }),
    });
  });

  it.each([
    { accountNumber: "9999999999", transferType: "in" },
    { accountNumber: "1017588888", transferType: "out" },
  ])("ignores a valid unrelated or outgoing webhook without business writes", async (overrides) => {
    const tx = buildTx(buildCandidate());

    await expect(buildService(tx).handleWebhook({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      transactionDate: "2026-08-10T21:00:00+07:00",
      accountNumber: overrides.accountNumber,
      code: "PAY-TEST-001",
      content: "PAY-TEST-001 chuyen tien",
      transferType: overrides.transferType,
      transferAmount: 100_000,
      referenceCode: "FT24012345678",
    }, { authorization: "Apikey test-webhook-key" })).resolves.toMatchObject({
      duplicate: false,
      matched: false,
      ignored: true,
      transactionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });

    expect(tx.sepayTransaction.findUnique).not.toHaveBeenCalled();
    expect(tx.sepayTransaction.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.createMany).not.toHaveBeenCalled();
    expect(tx.notification.upsert).not.toHaveBeenCalled();
    expect(tx.notification.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    { transactionDate: "2026-02-30 21:00:00", transferAmount: 100_000 },
    { transactionDate: "2026-02-30T21:00:00+07:00", transferAmount: 100_000 },
    { id: Number.MAX_SAFE_INTEGER + 1, transactionDate: "2026-08-10 21:00:00", transferAmount: 100_000 },
    { transactionDate: "2026-08-10 21:00:00", transferAmount: Number.MAX_SAFE_INTEGER + 1 },
    { transactionDate: "2026-08-10 21:00:00", transferAmount: "100000.50" },
    { transactionDate: "2026-08-10 21:00:00", transferAmount: "9223372036854775808" },
    { transactionDate: "2026-08-10 21:00:00", transferAmount: 0 },
  ])("rejects malformed dates and noncanonical or unbounded amounts", async (overrides) => {
    const tx = buildTx(null);

    await expect(buildService(tx).handleWebhook({
      id: 92704,
      accountNumber: "1017588888",
      content: "PAY-TEST-001",
      transferType: "in",
      ...overrides,
    }, { authorization: "Apikey test-webhook-key" })).rejects.toMatchObject({ statusCode: 400 });
    expect(tx.sepayTransaction.findUnique).not.toHaveBeenCalled();
  });

  it("returns 503 when the bank account is not configured", async () => {
    vi.stubEnv("SEPAY_BANK_ACCOUNT", "");
    const tx = buildTx(null);

    await expect(buildService(tx).handleWebhook({
      id: 92704,
      transactionDate: "2026-08-10 21:00:00",
      accountNumber: "1017588888",
      content: "PAY-TEST-001",
      transferType: "in",
      transferAmount: 100_000,
    }, { authorization: "Apikey test-webhook-key" })).rejects.toMatchObject({ statusCode: 503 });
    expect(tx.sepayTransaction.findUnique).not.toHaveBeenCalled();
  });

  it("classifies underpaid webhook without queueing the order", async () => {
    const tx = buildTx(buildCandidate());
    const result = await buildService(tx).handleWebhook(
      webhook({ id: "99007002", transferAmount: "90000", content: "PAY-TEST-001" }),
      { authorization: "Apikey test-webhook-key" }
    );

    expect(result.matchStatus).toBe(TransactionMatchStatus.UNMATCHED);
    expect(tx.order.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "order-1", paymentStatus: PaymentStatus.PENDING }),
      data: { paymentStatus: PaymentStatus.UNDERPAID },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ event: "PAYMENT_REVIEW", recipientUserId: "owner-1" })],
      skipDuplicates: true,
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "SEPAY_WEBHOOK_REVIEW_REQUIRED" }),
    }));
  });

  it("classifies overpaid webhook without queueing the order", async () => {
    const tx = buildTx(buildCandidate());
    const result = await buildService(tx).handleWebhook(
      webhook({ id: "99007003", transferAmount: "120000", content: "PAY-TEST-001" }),
      { authorization: "Apikey test-webhook-key" }
    );

    expect(result.matchStatus).toBe(TransactionMatchStatus.UNMATCHED);
    expect(tx.order.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "order-1", paymentStatus: PaymentStatus.PENDING }),
      data: { paymentStatus: PaymentStatus.OVERPAID },
    });
  });

  it("records cancelled-order payments for review without changing settled state", async () => {
    const tx = buildTx(buildCandidate(undefined, {
      order: { fulfillmentStatus: FulfillmentStatus.CANCELLED },
    }));
    const result = await buildService(tx).handleWebhook(
      webhook({ id: "99007006", transferAmount: "100000", content: "PAY-TEST-001" }),
      { authorization: "Apikey test-webhook-key" }
    );

    expect(result.matchStatus).toBe(TransactionMatchStatus.UNMATCHED);
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.createMany).not.toHaveBeenCalled();
    expect(tx.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ event: "PAYMENT_REVIEW", orderId: "order-1" })],
      skipDuplicates: true,
    }));
  });

  it("stores wrong-code webhook without linking payment", async () => {
    const tx = buildTx(null);
    const result = await buildService(tx).handleWebhook(
      webhook({ id: "99007004", transferAmount: "100000", content: "PAY-WRONG-001" }),
      { authorization: "Apikey test-webhook-key" }
    );

    expect(result).toMatchObject({
      duplicate: false,
      matched: false,
      paymentId: null,
      matchStatus: TransactionMatchStatus.WRONG_CODE,
    });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ event: "PAYMENT_REVIEW", orderId: undefined })],
      skipDuplicates: true,
    }));
  });

  it.each([["P2025", "99007025"], ["P2034", "99007034"]])(
    "returns typed 409 after three exhausted %s transaction attempts",
    async (code, externalId) => {
      const conflict = Object.assign(new Error("concurrent conflict"), { code });
      const transaction = vi.fn().mockRejectedValue(conflict);
      const service = new SepayService({ $transaction: transaction } as any);

      await expect(service.handleWebhook(
        webhook({ id: externalId, content: "PAY-TEST-001" }),
        { authorization: "Apikey test-webhook-key" },
      )).rejects.toMatchObject({ statusCode: 409 });
      expect(transaction).toHaveBeenCalledTimes(3);
    },
  );

  it("propagates unrelated transaction errors without retrying", async () => {
    const unrelated = Object.assign(new Error("unrelated database failure"), { code: "P2003" });
    const transaction = vi.fn().mockRejectedValue(unrelated);
    const service = new SepayService({ $transaction: transaction } as any);

    await expect(service.handleWebhook(
      webhook({ id: "99007003", content: "PAY-TEST-001" }),
      { authorization: "Apikey test-webhook-key" },
    )).rejects.toBe(unrelated);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("returns success for duplicate webhook without processing twice", async () => {
    const existingTransaction = {
      id: "transaction-existing",
      paymentId: "payment-1",
      matchStatus: TransactionMatchStatus.MATCHED,
    };
    const tx = buildTx(buildCandidate(), existingTransaction);

    const result = await buildService(tx).handleWebhook(
      webhook({ id: "99007005", transferAmount: "100000", content: "PAY-TEST-001" }),
      { authorization: "Apikey test-webhook-key" }
    );

    expect(result).toEqual({
      duplicate: true,
      matched: true,
      transactionId: "transaction-existing",
      paymentId: "payment-1",
      matchStatus: TransactionMatchStatus.MATCHED,
    });
    expect(tx.sepayTransaction.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.notification.upsert).not.toHaveBeenCalled();
    expect(tx.notification.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
