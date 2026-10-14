import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";

import { createDisposableTestDatabase } from "../../admin/tests/disposable-test-database";
import type { NormalizedSepayTransaction } from "../sepay-transaction";
import { SepayService } from "../sepay.service";

const database = createDisposableTestDatabase(
  process.env.TEST_DATABASE_URL,
  (url) => new PrismaClient({ datasources: { db: { url } } }),
);
const suite = database ? describe : describe.skip;
const runId = randomUUID();
const marker = runId.replace(/-/g, "").slice(0, 12).toUpperCase();
const ids = {
  owner: randomUUID(),
  staff: randomUUID(),
  barista: randomUUID(),
};
const orderIds: string[] = [];
const SEPAY_INSERT_LOCK_KEY = 20_261_014;

function transaction(overrides: Partial<NormalizedSepayTransaction> = {}): NormalizedSepayTransaction {
  const externalId = overrides.externalId ?? randomUUID();
  return {
    externalId,
    accountNumber: "111122223333",
    direction: "in",
    amountIn: 25_000n,
    transactionDate: new Date(),
    content: "unrelated transfer",
    paymentCode: null,
    referenceCode: null,
    rawPayload: { id: externalId, marker: runId },
    ...overrides,
  };
}

async function createPaymentFixture(options: {
  paymentCode?: string;
  orderCode?: string;
  paymentStatus?: "PENDING" | "PAID" | "REVIEW";
  fulfillmentStatus?: "PENDING_PAYMENT" | "QUEUED" | "PREPARING" | "READY" | "DELIVERED" | "CANCELLED";
  receivedAmount?: bigint;
  expectedAmount?: bigint;
}) {
  const orderId = randomUUID();
  orderIds.push(orderId);
  const expectedAmount = options.expectedAmount ?? 25_000n;
  const paymentStatus = options.paymentStatus ?? "PENDING";
  return database!.order.create({
    data: {
      id: orderId,
      orderCode: options.orderCode ?? `ORD-C2-${marker}-${orderIds.length}`,
      createdByUserId: ids.staff,
      paymentMethod: "QR",
      paymentStatus,
      fulfillmentStatus: options.fulfillmentStatus ?? "PENDING_PAYMENT",
      assignedBaristaId: options.fulfillmentStatus === "PREPARING" || options.fulfillmentStatus === "READY"
        ? ids.barista
        : null,
      cancellationReason: options.fulfillmentStatus === "CANCELLED" ? "C2 settled fixture" : null,
      totalAmount: expectedAmount,
      paidAt: paymentStatus === "PAID" ? new Date() : null,
      payment: {
        create: {
          paymentCode: options.paymentCode ?? `PAYC2${marker}${orderIds.length}`,
          expectedAmount,
          receivedAmount: options.receivedAmount ?? (paymentStatus === "PAID" ? expectedAmount : 0n),
        },
      },
    },
    include: { payment: true },
  });
}

async function cleanupFixtures() {
  if (!database) return;
  await database.notification.deleteMany({
    where: { recipientUserId: { in: [ids.owner, ids.staff, ids.barista] } },
  });
  const sepayRows = await database.sepayTransaction.findMany({
    where: { rawPayload: { path: ["marker"], equals: runId } },
    select: { id: true },
  });
  const sepayIds = sepayRows.map(({ id }) => id);
  if (sepayIds.length > 0) {
    await database.auditLog.deleteMany({ where: { entityId: { in: sepayIds } } });
  }
  if (orderIds.length > 0) {
    await database.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  }
  await database.sepayTransaction.deleteMany({
    where: { rawPayload: { path: ["marker"], equals: runId } },
  });
  if (orderIds.length > 0) {
    await database.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.order.deleteMany({ where: { id: { in: orderIds } } });
  }
}

async function waitForBlockedSePayInserts(expectedCount: bigint) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await database!.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted = false
    `;
    if (rows[0]!.count >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} blocked SePay inserts`);
}

async function runOverlappingInserts<T>(operations: () => Array<Promise<T>>) {
  await database!.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION security_test_c2_block_sepay_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${SEPAY_INSERT_LOCK_KEY});
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await database!.$executeRawUnsafe("DROP TRIGGER IF EXISTS security_test_c2_block_sepay_insert_trigger ON sepay_transactions");
  await database!.$executeRawUnsafe(`
    CREATE TRIGGER security_test_c2_block_sepay_insert_trigger
      BEFORE INSERT ON sepay_transactions
      FOR EACH ROW EXECUTE FUNCTION security_test_c2_block_sepay_insert()
  `);

  const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await blocker.connect();
  let locked = false;
  try {
    await blocker.query("SELECT pg_advisory_lock($1)", [SEPAY_INSERT_LOCK_KEY]);
    locked = true;
    const pending = operations();
    await waitForBlockedSePayInserts(BigInt(pending.length));
    await blocker.query("SELECT pg_advisory_unlock($1)", [SEPAY_INSERT_LOCK_KEY]);
    locked = false;
    return await Promise.allSettled(pending);
  } finally {
    if (locked) await blocker.query("SELECT pg_advisory_unlock($1)", [SEPAY_INSERT_LOCK_KEY]);
    await blocker.end();
    await database!.$executeRawUnsafe("DROP TRIGGER IF EXISTS security_test_c2_block_sepay_insert_trigger ON sepay_transactions");
    await database!.$executeRawUnsafe("DROP FUNCTION IF EXISTS security_test_c2_block_sepay_insert()");
  }
}

suite("SePay exact matching and concurrent delivery security", () => {
  beforeAll(async () => {
    process.env.SEPAY_BANK_ACCOUNT = "111122223333";
    process.env.SEPAY_WEBHOOK_API_KEY = "c2-test-key";
    await database!.$connect();
    await database!.user.createMany({
      data: [
        {
          id: ids.owner,
          fullName: "C2 Security Owner",
          username: `c2-owner-${runId}`,
          passwordHash: "$2b$12$c2.security.integration.fixture.only",
          role: "OWNER",
          status: "ACTIVE",
          telegramChatId: 7_100_000_000_001n,
        },
        {
          id: ids.staff,
          fullName: "C2 Security Staff",
          telegramUserId: 7_100_000_000_002n,
          role: "SERVICE_STAFF",
          status: "ACTIVE",
        },
        {
          id: ids.barista,
          fullName: "C2 Security Barista",
          telegramUserId: 7_100_000_000_003n,
          role: "BARISTA",
          status: "ACTIVE",
        },
      ],
    });
  });

  afterAll(async () => {
    if (!database) return;
    await database.$executeRawUnsafe("DROP TRIGGER IF EXISTS security_test_c2_block_sepay_insert_trigger ON sepay_transactions");
    await database.$executeRawUnsafe("DROP FUNCTION IF EXISTS security_test_c2_block_sepay_insert()");
    await cleanupFixtures();
    await database.user.deleteMany({ where: { id: { in: [ids.owner, ids.staff, ids.barista] } } });
    await database.$disconnect();
  });

  it("matches only one complete payment-code token and never falls back to order codes or substrings", async () => {
    const firstCode = `PAYC2${marker}A`;
    const secondCode = `PAYC2${marker}B`;
    const first = await createPaymentFixture({ paymentCode: firstCode });
    await createPaymentFixture({ paymentCode: secondCode });
    const service = new SepayService(database!);

    const unsafeContents = [
      firstCode.slice(0, -2),
      `XX${firstCode}YY`,
      first.orderCode,
      `${firstCode} ${secondCode}`,
    ];
    for (const content of unsafeContents) {
      const result = await service.handleTrustedTransaction(transaction({ content }));
      expect(result).toMatchObject({ matched: false, paymentId: null });
    }

    const exact = await service.handleTrustedTransaction(transaction({ content: `Payment ${firstCode}` }));
    expect(exact).toMatchObject({ matched: true, paymentId: first.payment!.id });

    const persistedUnsafe = await database!.sepayTransaction.findMany({
      where: {
        rawPayload: { path: ["marker"], equals: runId },
        id: { not: exact.transactionId },
      },
      select: { paymentId: true, matchStatus: true },
    });
    expect(persistedUnsafe).toHaveLength(unsafeContents.length);
    expect(persistedUnsafe.every((row) => row.paymentId === null)).toBe(true);
    expect(persistedUnsafe.every((row) => row.matchStatus === "WRONG_CODE")).toBe(true);
  });

  it.each(["QUEUED", "PREPARING", "READY", "DELIVERED", "CANCELLED"] as const)(
    "does not downgrade or overwrite a paid %s order when a later transfer needs review",
    async (fulfillmentStatus) => {
      const fixture = await createPaymentFixture({
        paymentStatus: "PAID",
        fulfillmentStatus,
        receivedAmount: 25_000n,
      });
      const service = new SepayService(database!);

      const result = await service.handleTrustedTransaction(transaction({
        amountIn: 30_000n,
        content: fixture.payment!.paymentCode!,
      }));

      expect(result).toMatchObject({ matched: false, paymentId: fixture.payment!.id });
      const [order, payment, historyCount] = await Promise.all([
        database!.order.findUniqueOrThrow({ where: { id: fixture.id } }),
        database!.payment.findUniqueOrThrow({ where: { id: fixture.payment!.id } }),
        database!.orderStatusHistory.count({ where: { orderId: fixture.id } }),
      ]);
      expect(order.paymentStatus).toBe("PAID");
      expect(order.fulfillmentStatus).toBe(fulfillmentStatus);
      expect(payment.receivedAmount).toBe(25_000n);
      expect(historyCount).toBe(0);
    },
  );

  it("returns success for concurrent duplicate external IDs without replaying side effects", async () => {
    const fixture = await createPaymentFixture({});
    const externalId = randomUUID();
    const input = transaction({
      externalId,
      content: fixture.payment!.paymentCode!,
    });
    const service = new SepayService(database!);

    const outcomes = await runOverlappingInserts(() => [
      service.handleTrustedTransaction(input),
      service.handleTrustedTransaction(input),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<any>).value);
    expect(results.filter(({ duplicate }) => duplicate)).toHaveLength(1);
    expect(results.filter(({ matched }) => matched)).toHaveLength(2);
    expect(await database!.sepayTransaction.count({ where: { sepayTransactionId: externalId } })).toBe(1);
    expect(await database!.auditLog.count({
      where: { action: "SEPAY_WEBHOOK_MATCHED", entityId: results[0].transactionId },
    })).toBe(1);
    expect(await database!.orderStatusHistory.count({ where: { orderId: fixture.id } })).toBe(2);
    expect(await database!.notification.count({
      where: { event: "ORDER_PAID", sourceKey: fixture.id },
    })).toBe(2);
    const duplicateNotifications = await database!.notification.findMany({
      where: { event: "ORDER_PAID", sourceKey: fixture.id },
      select: { recipientUserId: true },
    });
    expect(new Set(duplicateNotifications.map(({ recipientUserId }) => recipientUserId)).size).toBe(2);
  });

  it("settles only one of two different transactions racing for the same payment", async () => {
    const fixture = await createPaymentFixture({});
    const first = transaction({ content: fixture.payment!.paymentCode! });
    const second = transaction({ content: fixture.payment!.paymentCode! });
    const service = new SepayService(database!);

    const outcomes = await runOverlappingInserts(() => [
      service.handleTrustedTransaction(first),
      service.handleTrustedTransaction(second),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<any>).value);
    expect(results.filter(({ matched }) => matched)).toHaveLength(1);
    expect(results.filter(({ matched }) => !matched)).toHaveLength(1);
    const [order, payment, rows] = await Promise.all([
      database!.order.findUniqueOrThrow({ where: { id: fixture.id } }),
      database!.payment.findUniqueOrThrow({ where: { id: fixture.payment!.id } }),
      database!.sepayTransaction.findMany({
        where: { sepayTransactionId: { in: [first.externalId, second.externalId] } },
      }),
    ]);
    expect(order).toMatchObject({ paymentStatus: "PAID", fulfillmentStatus: "QUEUED" });
    expect(payment.receivedAmount).toBe(25_000n);
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ matchStatus }) => matchStatus === "MATCHED")).toHaveLength(1);
    const auditRows = await database!.auditLog.findMany({
      where: { entityId: { in: rows.map(({ id }) => id) } },
      select: { action: true },
    });
    expect(auditRows.filter(({ action }) => action === "SEPAY_WEBHOOK_MATCHED")).toHaveLength(1);
    expect(auditRows.filter(({ action }) => action === "SEPAY_WEBHOOK_REVIEW_REQUIRED")).toHaveLength(1);
    expect(await database!.orderStatusHistory.count({ where: { orderId: fixture.id } })).toBe(2);
    expect(await database!.notification.count({
      where: { event: "ORDER_PAID", sourceKey: fixture.id },
    })).toBe(2);
  });

  it("applies the same single-settlement rules to a webhook and active-lookup race", async () => {
    const fixture = await createPaymentFixture({});
    const webhookExternalId = randomUUID();
    const lookup = transaction({ content: fixture.payment!.paymentCode! });
    const service = new SepayService(database!);
    const webhookPayload = {
      id: webhookExternalId,
      transactionDate: "2026-10-14 12:00:00",
      accountNumber: "111122223333",
      code: fixture.payment!.paymentCode!,
      content: fixture.payment!.paymentCode!,
      transferType: "in",
      transferAmount: 25_000,
      marker: runId,
    };

    const outcomes = await runOverlappingInserts(() => [
      service.handleWebhook(webhookPayload, { authorization: "Apikey c2-test-key" }),
      service.handleTrustedTransaction(lookup),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<any>).value);
    expect(results.filter(({ matched }) => matched)).toHaveLength(1);
    expect(results.filter(({ matched }) => !matched)).toHaveLength(1);
    const raceRows = await database!.sepayTransaction.findMany({
      where: { sepayTransactionId: { in: [webhookExternalId, lookup.externalId] } },
    });
    expect(raceRows).toHaveLength(2);
    expect(raceRows.filter(({ matchStatus }) => matchStatus === "MATCHED")).toHaveLength(1);
    const [order, payment, auditRows] = await Promise.all([
      database!.order.findUniqueOrThrow({ where: { id: fixture.id } }),
      database!.payment.findUniqueOrThrow({ where: { id: fixture.payment!.id } }),
      database!.auditLog.findMany({
        where: { entityId: { in: raceRows.map(({ id }) => id) } },
        select: { action: true },
      }),
    ]);
    expect(order).toMatchObject({ paymentStatus: "PAID", fulfillmentStatus: "QUEUED" });
    expect(payment.receivedAmount).toBe(25_000n);
    expect(auditRows.filter(({ action }) => action === "SEPAY_WEBHOOK_MATCHED")).toHaveLength(1);
    expect(auditRows.filter(({ action }) => action === "SEPAY_WEBHOOK_REVIEW_REQUIRED")).toHaveLength(1);
    expect(await database!.orderStatusHistory.count({ where: { orderId: fixture.id } })).toBe(2);
    expect(await database!.notification.count({
      where: { event: "ORDER_PAID", sourceKey: fixture.id },
    })).toBe(2);
  });
});
