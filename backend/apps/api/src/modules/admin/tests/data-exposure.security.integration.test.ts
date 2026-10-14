import { randomUUID } from "node:crypto";

import {
  AuditEntityType,
  PrismaClient,
  ResolutionAction,
  TransactionMatchStatus,
  UserRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDisposableTestDatabase } from "./disposable-test-database";

const database = createDisposableTestDatabase(
  process.env.TEST_DATABASE_URL,
  (validatedUrl) => new PrismaClient({ datasources: { db: { url: validatedUrl } } }),
);

const ownerId = randomUUID();
const baristaId = randomUUID();
const orderId = randomUUID();
const transactionId = randomUUID();
const marker = `DATA_EXPOSURE_${randomUUID()}`;

let AdminOrderRepository: typeof import("../admin.repository").AdminOrderRepository;
let AuditService: typeof import("../../audit/audit.service").AuditService;
let ReconciliationService: typeof import("../../reconciliations/reconciliation.service").ReconciliationService;

function expectSafeUser(
  user: unknown,
  expected: { id: string; fullName: string; role: UserRole },
) {
  expect(user).toEqual(expected);

  const serialized = JSON.stringify(user);
  expect(serialized).not.toContain("passwordHash");
  expect(serialized).not.toContain("SENTINEL_HASH");
  expect(serialized).not.toContain("telegramChatId");
  expect(serialized).not.toContain("telegramUserId");
  expect(serialized).not.toContain("username");
  expect(serialized).not.toContain("status");
  expect(serialized).not.toContain("createdAt");
  expect(serialized).not.toContain("updatedAt");
}

describe.skipIf(!database)("safe user relations disposable-database acceptance", () => {
  beforeAll(async () => {
    await database!.$connect();
    vi.doMock("../../../db", () => ({ prisma: database }));

    ({ AdminOrderRepository } = await import("../admin.repository"));
    ({ AuditService } = await import("../../audit/audit.service"));
    ({ ReconciliationService } = await import("../../reconciliations/reconciliation.service"));

    await database!.user.createMany({
      data: [
        {
          id: ownerId,
          fullName: "Security Test Owner",
          username: `owner-${ownerId}`,
          passwordHash: "SENTINEL_HASH",
          telegramUserId: BigInt(`1${Date.now()}`),
          telegramChatId: BigInt(`2${Date.now()}`),
          role: UserRole.OWNER,
        },
        {
          id: baristaId,
          fullName: "Security Test Barista",
          username: `barista-${baristaId}`,
          passwordHash: "SENTINEL_HASH",
          telegramUserId: BigInt(`3${Date.now()}`),
          telegramChatId: BigInt(`4${Date.now()}`),
          role: UserRole.BARISTA,
        },
      ],
    });

    await database!.order.create({
      data: {
        id: orderId,
        orderCode: `SEC-${orderId.slice(0, 8)}`,
        createdByUserId: ownerId,
        assignedBaristaId: baristaId,
        totalAmount: 100n,
      },
    });

    await database!.auditLog.createMany({
      data: [
        {
          actorUserId: ownerId,
          action: marker,
          entityType: AuditEntityType.ORDER,
          entityId: orderId,
        },
        {
          actorUserId: null,
          action: `${marker}_NULL`,
          entityType: AuditEntityType.ORDER,
          entityId: orderId,
        },
      ],
    });

    await database!.sepayTransaction.create({
      data: {
        id: transactionId,
        sepayTransactionId: `security-${transactionId}`,
        transactionDate: new Date(),
        amountIn: 100n,
        matchStatus: TransactionMatchStatus.UNMATCHED,
        rawPayload: {},
      },
    });
  });

  afterAll(async () => {
    if (!database) return;

    await database.auditLog.deleteMany({
      where: {
        OR: [
          { action: { startsWith: marker } },
          { entityId: transactionId },
        ],
      },
    });
    await database.sepayTransaction.deleteMany({ where: { id: transactionId } });
    await database.order.deleteMany({ where: { id: orderId } });
    await database.user.deleteMany({ where: { id: { in: [ownerId, baristaId] } } });
    await database.$disconnect();
    vi.doUnmock("../../../db");
  });

  it("returns only id, fullName and role from real user relations", async () => {
    const owner = {
      id: ownerId,
      fullName: "Security Test Owner",
      role: UserRole.OWNER,
    };
    const barista = {
      id: baristaId,
      fullName: "Security Test Barista",
      role: UserRole.BARISTA,
    };

    const adminRepository = new AdminOrderRepository();
    const list = await adminRepository.findAll({ createdByUserId: ownerId });
    const detail = await adminRepository.findById(orderId);

    const listedOrder = list.data.find((order) => order.id === orderId);
    expectSafeUser(listedOrder?.creator, owner);
    expectSafeUser(listedOrder?.assignedBarista, barista);
    expectSafeUser(detail?.creator, owner);
    expectSafeUser(detail?.assignedBarista, barista);

    const auditLogs = await new AuditService().listAuditLogs();
    const actorLog = auditLogs.find((log) => log.action === marker);
    const nullActorLog = auditLogs.find((log) => log.action === `${marker}_NULL`);
    expectSafeUser(actorLog?.actor, owner);
    expect(nullActorLog?.actor).toBeNull();

    const reconciliationService = new ReconciliationService(database!);
    const transactions = await reconciliationService.listTransactions();
    const transaction = await reconciliationService.getTransaction(transactionId);
    const reconciliations = await reconciliationService.listReconciliations();
    const reconciliation = await reconciliationService.getReconciliation(transactionId);

    expect(transactions.find((item) => item.id === transactionId)?.resolvedBy).toBeNull();
    expect(transaction.resolvedBy).toBeNull();
    expect(reconciliations.find((item) => item.id === transactionId)?.resolvedBy).toBeNull();
    expect(reconciliation.resolvedBy).toBeNull();

    const resolved = await reconciliationService.resolveReconciliation(transactionId, {
      resolvedByUserId: ownerId,
      resolutionAction: ResolutionAction.ACCEPT,
      resolutionNote: "Security acceptance",
    });
    expectSafeUser(resolved.resolvedBy, owner);

    await database!.sepayTransaction.update({
      where: { id: transactionId },
      data: { matchStatus: TransactionMatchStatus.UNMATCHED },
    });

    const transactionsAfterResolve = await reconciliationService.listTransactions();
    const transactionAfterResolve = await reconciliationService.getTransaction(transactionId);
    const reconciliationsAfterResolve = await reconciliationService.listReconciliations();
    const reconciliationAfterResolve = await reconciliationService.getReconciliation(transactionId);

    expectSafeUser(
      transactionsAfterResolve.find((item) => item.id === transactionId)?.resolvedBy,
      owner,
    );
    expectSafeUser(transactionAfterResolve.resolvedBy, owner);
    expectSafeUser(
      reconciliationsAfterResolve.find((item) => item.id === transactionId)?.resolvedBy,
      owner,
    );
    expectSafeUser(reconciliationAfterResolve.resolvedBy, owner);
  });
});
