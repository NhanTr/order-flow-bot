import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { createDisposableTestDatabase } from "../../admin/tests/disposable-test-database";
import type { AccessIdentity } from "../../auth/auth.types";

const database = createDisposableTestDatabase(
  process.env.TEST_DATABASE_URL,
  (url) => new PrismaClient({ datasources: { db: { url } } }),
);

vi.mock("../../../db", () => ({ prisma: database }));

const suite = database ? describe : describe.skip;
const runId = randomUUID();
const telegramBase = 8_000_000_000_000n + BigInt(`0x${runId.replace(/-/g, "").slice(0, 10)}`) * 10n;
const ids = {
  owner: randomUUID(),
  staff: randomUUID(),
};
const owner: AccessIdentity = { userId: ids.owner, sessionId: `refund-owner-${runId}`, role: "OWNER" };
let RefundServiceClass: any;

async function migrationSql(): Promise<string> {
  return readFile(
    path.resolve(process.cwd(), "../../prisma/sql/2026-10-13_refund_idempotency.sql"),
    "utf8",
  );
}

async function executeMigration(sql: string) {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createPaidOrder() {
  return database!.order.create({
    data: {
      id: randomUUID(),
      orderCode: `REF${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`,
      createdByUserId: ids.staff,
      fulfillmentStatus: "QUEUED",
      paymentStatus: "PAID",
      totalAmount: 25_000n,
      paidAt: new Date(),
      payment: {
        create: {
          paymentCode: `RFP${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
          expectedAmount: 25_000n,
          receivedAmount: 25_000n,
          confirmedAt: new Date(),
          cashConfirmedByUserId: ids.staff,
        },
      },
    },
    include: { payment: true },
  });
}

async function cleanup() {
  if (!database) return;
  const orders = await database.order.findMany({
    where: { createdByUserId: ids.staff },
    select: { id: true },
  });
  const orderIds = orders.map(({ id }) => id);
  const payments = orderIds.length > 0
    ? await database.payment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
    : [];
  const entityIds = [...orderIds, ...payments.map(({ id }) => id)];
  if (entityIds.length > 0) {
    await database.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
  }
  if (orderIds.length > 0) {
    await database.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.order.deleteMany({ where: { id: { in: orderIds } } });
  }
}

suite("manual refund idempotency security", () => {
  beforeAll(async () => {
    await database!.$connect();
    ({ RefundService: RefundServiceClass } = await import("../refund.service"));
    await database!.user.createMany({
      data: [
        {
          id: ids.owner,
          fullName: "Refund Owner",
          username: `refund-owner-${runId}`,
          passwordHash: "$2b$12$security.integration.fixture.hash.only",
          role: "OWNER",
          status: "ACTIVE",
        },
        { id: ids.staff, fullName: "Refund Staff", telegramUserId: telegramBase + 1n, role: "SERVICE_STAFF", status: "ACTIVE" },
      ],
    });
  });

  afterAll(async () => {
    if (!database) return;
    await cleanup();
    await database.user.deleteMany({ where: { id: { in: [ids.owner, ids.staff] } } });
    await database.$disconnect();
  });

  it("aborts migration on duplicates without deleting rows, then applies rerunnably after cleanup", async () => {
    await database!.$executeRawUnsafe("DROP INDEX IF EXISTS audit_logs_manual_refund_payment_unique_idx");
    const order = await createPaidOrder();
    const paymentId = order.payment!.id;
    await database!.auditLog.createMany({
      data: [
        { actorUserId: ids.owner, action: "MANUAL_REFUND_RECORDED", entityType: "PAYMENT", entityId: paymentId, details: { marker: runId } },
        { actorUserId: ids.owner, action: "MANUAL_REFUND_RECORDED", entityType: "PAYMENT", entityId: paymentId, details: { marker: runId } },
      ],
    });

    const sql = await migrationSql();
    await expect(executeMigration(sql)).rejects.toThrow(/duplicate.*manual refund|manual refund.*duplicate/i);
    expect(await database!.auditLog.count({
      where: { action: "MANUAL_REFUND_RECORDED", entityType: "PAYMENT", entityId: paymentId },
    })).toBe(2);

    await database!.auditLog.deleteMany({
      where: { action: "MANUAL_REFUND_RECORDED", entityType: "PAYMENT", entityId: paymentId },
    });
    await expect(executeMigration(sql)).resolves.toBeDefined();
    await expect(executeMigration(sql)).resolves.toBeDefined();
    const indexes = await database!.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'audit_logs_manual_refund_payment_unique_idx'
    `;
    expect(indexes[0]!.count).toBe(1n);
  });

  it("allows exactly one concurrent refund request for the same payment", async () => {
    const order = await createPaidOrder();
    const paymentId = order.payment!.id;
    const service = new RefundServiceClass(database);
    const outcomes = await Promise.allSettled([
      service.refundOrder(order.id, { refundedByUserId: owner.userId, reason: "Duplicate race A" }),
      service.refundOrder(order.id, { refundedByUserId: owner.userId, reason: "Duplicate race B" }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.statusCode ?? rejection.reason.status).toBe(409);
    expect(await database!.auditLog.count({
      where: { action: "MANUAL_REFUND_RECORDED", entityType: "PAYMENT", entityId: paymentId },
    })).toBe(1);
  });

  it("allows one refund record for each of two different payments", async () => {
    const first = await createPaidOrder();
    const second = await createPaidOrder();
    const service = new RefundServiceClass(database);

    await expect(Promise.all([
      service.refundOrder(first.id, { refundedByUserId: owner.userId, reason: "First payment" }),
      service.refundOrder(second.id, { refundedByUserId: owner.userId, reason: "Second payment" }),
    ])).resolves.toHaveLength(2);

    expect(await database!.auditLog.count({
      where: {
        action: "MANUAL_REFUND_RECORDED",
        entityType: "PAYMENT",
        entityId: { in: [first.payment!.id, second.payment!.id] },
      },
    })).toBe(2);
  });
});
