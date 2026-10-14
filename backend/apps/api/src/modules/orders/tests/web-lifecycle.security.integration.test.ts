import { randomUUID } from "node:crypto";
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
const telegramBase = 9_000_000_000_000n + BigInt(`0x${runId.replace(/-/g, "").slice(0, 10)}`) * 10n;
const CASH_RACE_LOCK_KEY = 20_261_013;
const ids = {
  owner: randomUUID(),
  staff: randomUUID(),
  baristaOne: randomUUID(),
  baristaTwo: randomUUID(),
  category: randomUUID(),
  menuItem: randomUUID(),
};

const owner: AccessIdentity = { userId: ids.owner, sessionId: `security-owner-${runId}`, role: "OWNER" };
const staff: AccessIdentity = { userId: ids.staff, sessionId: `security-staff-${runId}`, role: "SERVICE_STAFF" };

let OrderServiceClass: any;
let OrderRepositoryClass: any;
let HistoryRepositoryClass: any;
let PaymentRepositoryClass: any;
let PaymentServiceClass: any;

function service(): any {
  return new OrderServiceClass(
    new OrderRepositoryClass(),
    new HistoryRepositoryClass(),
    new PaymentRepositoryClass(),
    database,
  );
}

async function createOrderFixture(options: {
  fulfillmentStatus: "PENDING_PAYMENT" | "QUEUED" | "PREPARING" | "READY";
  paymentStatus: "UNPAID" | "PAID";
  quantity?: number;
  assignedBaristaId?: string | null;
}) {
  const orderId = randomUUID();
  const quantity = options.quantity ?? 1;
  const totalAmount = BigInt(10_000 * quantity);
  const order = await database!.order.create({
    data: {
      id: orderId,
      orderCode: `SEC${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`,
      createdByUserId: ids.staff,
      fulfillmentStatus: options.fulfillmentStatus,
      paymentStatus: options.paymentStatus,
      assignedBaristaId: options.assignedBaristaId ?? null,
      totalAmount,
      paidAt: options.paymentStatus === "PAID" ? new Date() : null,
      items: {
        create: {
          menuItemId: ids.menuItem,
          itemName: "Security Coffee",
          unitPrice: 10_000n,
          quantity,
        },
      },
      payment: {
        create: {
          paymentCode: `PAY${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
          expectedAmount: totalAmount,
          receivedAmount: options.paymentStatus === "PAID" ? totalAmount : 0n,
          confirmedAt: options.paymentStatus === "PAID" ? new Date() : null,
          cashConfirmedByUserId: options.paymentStatus === "PAID" ? ids.staff : null,
        },
      },
    },
    include: { items: true, payment: true },
  });
  return order;
}

async function cleanupFixtures() {
  if (!database) return;
  const orders = await database.order.findMany({
    where: { createdByUserId: ids.staff },
    select: { id: true },
  });
  const orderIds = orders.map(({ id }) => id);
  if (orderIds.length > 0) {
    await database.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.auditLog.deleteMany({ where: { entityId: { in: orderIds } } });
    await database.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await database.order.deleteMany({ where: { id: { in: orderIds } } });
  }
}

async function waitForBlockedAdvisoryLock() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await database!.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted = false
    `;
    if (rows[0]!.count > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the item edit to block on the advisory test gate");
}

suite("web lifecycle transaction security", () => {
  beforeAll(async () => {
    await database!.$connect();
    ({ OrderService: OrderServiceClass } = await import("../order.service"));
    ({ OrderRepository: OrderRepositoryClass } = await import("../order.repository"));
    ({ HistoryRepository: HistoryRepositoryClass } = await import("../../order-status-history/history.repository"));
    ({ PaymentRepository: PaymentRepositoryClass } = await import("../../payments/payment.repository"));
    ({ PaymentService: PaymentServiceClass } = await import("../../payments/payment.service"));

    await database!.user.createMany({
      data: [
        {
          id: ids.owner,
          fullName: "Security Owner",
          username: `owner-${runId}`,
          passwordHash: "$2b$12$security.integration.fixture.hash.only",
          role: "OWNER",
          status: "ACTIVE",
        },
        { id: ids.staff, fullName: "Security Staff", telegramUserId: telegramBase + 1n, role: "SERVICE_STAFF", status: "ACTIVE" },
        { id: ids.baristaOne, fullName: "Security Barista One", telegramUserId: telegramBase + 2n, role: "BARISTA", status: "ACTIVE" },
        { id: ids.baristaTwo, fullName: "Security Barista Two", telegramUserId: telegramBase + 3n, role: "BARISTA", status: "ACTIVE" },
      ],
    });
    await database!.menuCategory.create({
      data: { id: ids.category, name: `Security Category ${runId}`, displayOrder: 9000, isActive: true },
    });
    await database!.menuItem.create({
      data: {
        id: ids.menuItem,
        categoryId: ids.category,
        name: `Security Coffee ${runId}`,
        price: 10_000n,
        isAvailable: true,
      },
    });
  });

  afterAll(async () => {
    if (!database) return;
    await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS security_test_slow_item_update_trigger ON "order_items"');
    await database.$executeRawUnsafe('DROP FUNCTION IF EXISTS security_test_slow_item_update()');
    await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS security_test_fail_payment_trigger ON "payments"');
    await database.$executeRawUnsafe('DROP FUNCTION IF EXISTS security_test_fail_payment()');
    await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS security_test_fail_history_trigger ON "order_status_history"');
    await database.$executeRawUnsafe('DROP FUNCTION IF EXISTS security_test_fail_history()');
    await cleanupFixtures();
    await database.menuItem.deleteMany({ where: { id: ids.menuItem } });
    await database.menuCategory.deleteMany({ where: { id: ids.category } });
    await database.user.deleteMany({ where: { id: { in: [ids.owner, ids.staff, ids.baristaOne, ids.baristaTwo] } } });
    await database.$disconnect();
  });

  it("rolls back order and item creation when associated payment creation fails", async () => {
    await database!.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION security_test_fail_payment() RETURNS trigger AS $$
      BEGIN
        IF NEW.expected_amount = 10000 THEN
          RAISE EXCEPTION 'forced payment insert failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await database!.$executeRawUnsafe("DROP TRIGGER IF EXISTS security_test_fail_payment_trigger ON payments");
    await database!.$executeRawUnsafe(`
      CREATE TRIGGER security_test_fail_payment_trigger
        BEFORE INSERT ON payments
        FOR EACH ROW EXECUTE FUNCTION security_test_fail_payment()
    `);

    try {
      await expect(service().createOrder({
        items: [{ menuItemId: ids.menuItem, quantity: 1 }],
      }, staff)).rejects.toThrow(/forced payment insert failure/i);
    } finally {
      await database!.$executeRawUnsafe('DROP TRIGGER IF EXISTS security_test_fail_payment_trigger ON "payments"');
      await database!.$executeRawUnsafe('DROP FUNCTION IF EXISTS security_test_fail_payment()');
    }

    expect(await database!.order.count({ where: { createdByUserId: ids.staff } })).toBe(0);
    expect(await database!.orderItem.count({ where: { menuItemId: ids.menuItem } })).toBe(0);
  });

  it("allows exactly one concurrent claim and writes exactly one transition history row", async () => {
    const order = await createOrderFixture({ fulfillmentStatus: "QUEUED", paymentStatus: "PAID" });
    const outcomes = await Promise.allSettled([
      service().claimOrder(order.id, ids.baristaOne, owner),
      service().claimOrder(order.id, ids.baristaTwo, owner),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.statusCode ?? rejection.reason.status).toBe(409);
    const stored = await database!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.fulfillmentStatus).toBe("PREPARING");
    expect([ids.baristaOne, ids.baristaTwo]).toContain(stored.assignedBaristaId);
    expect(await database!.orderStatusHistory.count({
      where: { orderId: order.id, oldStatus: "QUEUED", newStatus: "PREPARING" },
    })).toBe(1);
  });

  it("preserves paid money fields when cancelling fulfillment", async () => {
    const order = await createOrderFixture({ fulfillmentStatus: "QUEUED", paymentStatus: "PAID" });
    const originalPaidAt = order.paidAt;
    const originalPayment = order.payment!;

    await service().cancelOrder(order.id, "Paid customer cancelled", owner);

    const storedOrder = await database!.order.findUniqueOrThrow({ where: { id: order.id } });
    const storedPayment = await database!.payment.findUniqueOrThrow({ where: { id: originalPayment.id } });
    expect(storedOrder.fulfillmentStatus).toBe("CANCELLED");
    expect(storedOrder.paymentStatus).toBe("PAID");
    expect(storedOrder.paidAt).toEqual(originalPaidAt);
    expect(storedPayment.expectedAmount).toBe(originalPayment.expectedAmount);
    expect(storedPayment.receivedAmount).toBe(originalPayment.receivedAmount);
    expect(storedPayment.confirmedAt).toEqual(originalPayment.confirmedAt);
    expect(await database!.orderStatusHistory.count({
      where: { orderId: order.id, oldStatus: "QUEUED", newStatus: "CANCELLED" },
    })).toBe(1);
  });

  it("allows exactly one PREPARING to READY or CANCELLED transition", async () => {
    const order = await createOrderFixture({
      fulfillmentStatus: "PREPARING",
      paymentStatus: "PAID",
      assignedBaristaId: ids.baristaOne,
    });
    const outcomes = await Promise.allSettled([
      service().markReady(order.id, "Owner override", owner),
      service().cancelOrder(order.id, "Customer cancelled", owner),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.statusCode ?? rejection.reason.status).toBe(409);
    const stored = await database!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(["READY", "CANCELLED"]).toContain(stored.fulfillmentStatus);
    expect(await database!.orderStatusHistory.count({
      where: { orderId: order.id, oldStatus: "PREPARING", newStatus: { in: ["READY", "CANCELLED"] } },
    })).toBe(1);
  });

  it("allows exactly one item edit or cash confirmation and keeps amounts consistent", async () => {
    const order = await createOrderFixture({ fulfillmentStatus: "PENDING_PAYMENT", paymentStatus: "UNPAID" });
    const payment = order.payment!;
    const item = order.items[0]!;
    const paymentService = new PaymentServiceClass(new PaymentRepositoryClass(), database);
    await database!.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION security_test_slow_item_update() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${CASH_RACE_LOCK_KEY});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await database!.$executeRawUnsafe("DROP TRIGGER IF EXISTS security_test_slow_item_update_trigger ON order_items");
    await database!.$executeRawUnsafe(`
      CREATE TRIGGER security_test_slow_item_update_trigger
        BEFORE UPDATE ON order_items
        FOR EACH ROW EXECUTE FUNCTION security_test_slow_item_update()
    `);

    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock($1)", [CASH_RACE_LOCK_KEY]);

    let edit: Promise<unknown> | undefined;
    let cashOutcome: PromiseSettledResult<unknown> | undefined;
    try {
      edit = service().updateItem(order.id, item.id, { quantity: 2 }, staff);
      await waitForBlockedAdvisoryLock();
      [cashOutcome] = await Promise.allSettled([
        paymentService.confirmCash(order.id, { amount: 10_000 }, staff),
      ]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [CASH_RACE_LOCK_KEY]);
      await blocker.end();
      await database!.$executeRawUnsafe('DROP TRIGGER IF EXISTS security_test_slow_item_update_trigger ON "order_items"');
      await database!.$executeRawUnsafe('DROP FUNCTION IF EXISTS security_test_slow_item_update()');
    }

    const [editOutcome] = await Promise.allSettled([edit!]);
    const outcomes = [editOutcome, cashOutcome!];

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.statusCode ?? rejection.reason.status).toBe(409);
    const storedOrder = await database!.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    const storedPayment = await database!.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (storedOrder.paymentStatus === "PAID") {
      expect(storedOrder.items[0]!.quantity).toBe(1);
      expect(storedOrder.totalAmount).toBe(10_000n);
      expect(storedPayment.receivedAmount).toBe(10_000n);
    } else {
      expect(storedOrder.items[0]!.quantity).toBe(2);
      expect(storedOrder.totalAmount).toBe(20_000n);
      expect(storedPayment.expectedAmount).toBe(20_000n);
      expect(storedPayment.receivedAmount).toBe(0n);
    }
  });

  it("rolls back a status change when history insertion fails", async () => {
    const order = await createOrderFixture({
      fulfillmentStatus: "PREPARING",
      paymentStatus: "PAID",
      assignedBaristaId: ids.baristaOne,
    });
    await database!.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION security_test_fail_history() RETURNS trigger AS $$
      BEGIN
        IF NEW.reason = 'SECURITY_FORCE_HISTORY_FAILURE' THEN
          RAISE EXCEPTION 'forced history insert failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await database!.$executeRawUnsafe("DROP TRIGGER IF EXISTS security_test_fail_history_trigger ON order_status_history");
    await database!.$executeRawUnsafe(`
      CREATE TRIGGER security_test_fail_history_trigger
        BEFORE INSERT ON order_status_history
        FOR EACH ROW EXECUTE FUNCTION security_test_fail_history()
    `);

    try {
      await expect(service().markReady(order.id, "SECURITY_FORCE_HISTORY_FAILURE", owner))
        .rejects.toThrow(/forced history insert failure/i);
    } finally {
      await database!.$executeRawUnsafe('DROP TRIGGER IF EXISTS security_test_fail_history_trigger ON "order_status_history"');
      await database!.$executeRawUnsafe('DROP FUNCTION IF EXISTS security_test_fail_history()');
    }

    expect((await database!.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentStatus)
      .toBe("PREPARING");
    expect(await database!.orderStatusHistory.count({ where: { orderId: order.id, newStatus: "READY" } }))
      .toBe(0);
  });
});
