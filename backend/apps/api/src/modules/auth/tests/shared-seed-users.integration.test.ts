import { randomUUID } from "node:crypto";
import { PrismaClient, UserRole } from "@prisma/client";
import { compare } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDisposableTestDatabase } from "../../admin/tests/disposable-test-database";
import { seedBe004IntegrationFixtures } from "../../../../../../prisma/seeds/be004-integration-fixtures.seed";
import { seedThai001CashPayment } from "../../../../../../prisma/seeds/thai001-cash-payment.seed";
import { seedThai002QrPayment } from "../../../../../../prisma/seeds/thai002-qr-payment.seed";
import { seedThai003SepayWebhook } from "../../../../../../prisma/seeds/thai003-sepay-webhook.seed";
import { seedThai004Reconciliation } from "../../../../../../prisma/seeds/thai004-reconciliation.seed";
import { seedThai005Refund } from "../../../../../../prisma/seeds/thai005-refund.seed";
import { seedThai006Revenue } from "../../../../../../prisma/seeds/thai006-revenue.seed";
import { seedAuditDemo } from "../../../../../../prisma/seeds/audit-demo.seed";
import { seedReconciliationDemo } from "../../../../../../prisma/seeds/reconciliation-demo.seed";

const database = createDisposableTestDatabase(process.env.TEST_DATABASE_URL,
  (url) => new PrismaClient({ datasources: { db: { url } } }));
const password = randomUUID();
const seeds = [seedBe004IntegrationFixtures, seedThai001CashPayment, seedThai002QrPayment,
  seedThai003SepayWebhook, seedThai004Reconciliation, seedThai005Refund, seedThai006Revenue,
  seedAuditDemo, seedReconciliationDemo];

// This suite needs its own empty, guarded test database. It never deletes existing data.
describe.skipIf(!database)("shared seed accounts", () => {
  beforeAll(async () => {
    await database!.$connect();
    if (await database!.user.count() !== 0) throw new Error("Seed acceptance requires an empty test database");
    vi.stubEnv("SEED_OWNER_USERNAME", "owner");
    vi.stubEnv("SEED_OWNER_PASSWORD", password);
    vi.stubEnv("SEED_PASSWORD_ROUNDS", "10");
    vi.stubEnv("SEED_OWNER_TELEGRAM_USER_ID", "94004001");
    vi.stubEnv("SEED_SERVICE_STAFF_TELEGRAM_USER_ID", "94004002");
    vi.stubEnv("SEED_BARISTA_TELEGRAM_USER_ID", "94004003");
  });
  afterAll(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await database?.$disconnect(); });

  it("reuses one account per role across every demo and rerun, with bcrypt and no password in logs", async () => {
    const logs: unknown[][] = [];
    for (const method of ["log", "info"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logs.push(args); });
    for (let pass = 0; pass < 2; pass++) {
      for (const seed of seeds) {
        await seed(database!);
        expect(await database!.user.count()).toBe(3);
      }
      const users = await database!.user.findMany();
      expect(users).toHaveLength(3);
      for (const role of [UserRole.OWNER, UserRole.SERVICE_STAFF, UserRole.BARISTA]) {
        expect(users.filter(user => user.role === role)).toHaveLength(1);
      }
      const owner = users.find(user => user.role === UserRole.OWNER)!;
      expect(owner.username).toBe("owner");
      expect(await compare(password, owner.passwordHash!)).toBe(true);
      expect(users.filter(user => user.role !== UserRole.OWNER).every(user => user.passwordHash === null)).toBe(true);
      const logged = JSON.stringify(logs, (_key, value) => typeof value === "bigint" ? value.toString() : value);
      expect(logged).not.toContain(password);
      expect(logged).not.toContain(owner.passwordHash);
      expect(logged).not.toContain("passwordHash");
    }
  }, 60000);

  it("rejects duplicate Telegram identities before changing any account", async () => {
    const before = await database!.user.findMany({ orderBy: { id: "asc" } });
    vi.stubEnv("SEED_SERVICE_STAFF_TELEGRAM_USER_ID", "94004001");
    try {
      await expect(seedBe004IntegrationFixtures(database!)).rejects.toThrow("distinct");
      expect(await database!.user.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    } finally { vi.stubEnv("SEED_SERVICE_STAFF_TELEGRAM_USER_ID", "94004002"); }
  });

  it("refuses implicit role changes and rolls back preceding OWNER updates", async () => {
    const barista = await database!.user.findUniqueOrThrow({ where: { username: "barista" } });
    await database!.user.update({ where: { id: barista.id }, data: { role: UserRole.SERVICE_STAFF } });
    const before = await database!.user.findMany({ orderBy: { id: "asc" } });
    try {
      await expect(seedBe004IntegrationFixtures(database!)).rejects.toThrow("Refusing");
      expect(await database!.user.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    } finally {
      await database!.user.update({ where: { id: barista.id }, data: { role: UserRole.BARISTA } });
    }
  });
});
