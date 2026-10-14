import { ResolutionAction, TransactionMatchStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  order: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  auditLog: {
    findMany: vi.fn(),
  },
}));

vi.mock("../../../db", () => ({ prisma: prismaMock }));

import { AdminOrderRepository } from "../admin.repository";
import { AuditService } from "../../audit/audit.service";
import { ReconciliationService } from "../../reconciliations/reconciliation.service";
import { createDisposableTestDatabase } from "./disposable-test-database";

const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  role: true,
};

const privateUser = {
  id: "user-1",
  fullName: "Safe User",
  role: "OWNER",
  passwordHash: "SENTINEL_HASH",
  telegramChatId: "987654321",
  telegramUserId: "123456789",
  username: "private-user",
  status: "ACTIVE",
  createdAt: new Date("2026-10-13T00:00:00.000Z"),
  updatedAt: new Date("2026-10-13T00:00:00.000Z"),
};

function projectUser(relation: unknown, user: typeof privateUser | null) {
  if (user === null) return null;
  if (relation === true) return { ...user };

  const select = (relation as { select?: Record<string, boolean> } | undefined)?.select;
  if (!select) return undefined;

  return Object.fromEntries(
    Object.entries(select)
      .filter(([, selected]) => selected)
      .map(([field]) => [field, user[field as keyof typeof user]]),
  );
}

function expectSafeSerializedUser(value: unknown) {
  expect(value).toEqual({
    id: privateUser.id,
    fullName: privateUser.fullName,
    role: privateUser.role,
  });

  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("passwordHash");
  expect(serialized).not.toContain("SENTINEL_HASH");
  expect(serialized).not.toContain("telegramChatId");
  expect(serialized).not.toContain("telegramUserId");
  expect(serialized).not.toContain("username");
  expect(serialized).not.toContain("status");
  expect(serialized).not.toContain("createdAt");
  expect(serialized).not.toContain("updatedAt");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("disposable test database guard", () => {
  it("refuses unsafe targets before constructing a database client", () => {
    const unsafeTargets = [
      ["not-a-url", "valid PostgreSQL URL"],
      ["mysql://user:pass@127.0.0.1:55439/order_flow_security_test", "PostgreSQL URL"],
      ["postgresql://user:pass@database.example.com:55439/order_flow_security_test", "loopback host"],
      ["postgresql://user:pass@127.0.0.1/order_flow_security_test", "explicit non-default port"],
      ["postgresql://user:pass@127.0.0.1:5432/order_flow_security_test", "explicit non-default port"],
      ["postgresql://user:pass@127.0.0.1:55439/order_flow", "order_flow_security_test"],
    ] as const;

    for (const [url, expectedMessage] of unsafeTargets) {
      const createClient = vi.fn();

      expect(() => createDisposableTestDatabase(url, createClient)).toThrow(expectedMessage);
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it("accepts loopback non-default ports and the isolated test database name", () => {
    const acceptedTargets = [
      "postgresql://user:pass@127.0.0.1:55439/order_flow_security_test",
      "postgres://user:pass@localhost:55440/order_flow_security_test_worker_1",
      "postgresql://user:pass@[::1]:55441/order_flow_security_test-run-2",
    ];

    for (const url of acceptedTargets) {
      const client = { url };
      const createClient = vi.fn(() => client);

      expect(createDisposableTestDatabase(url, createClient)).toBe(client);
      expect(createClient).toHaveBeenCalledOnce();
      expect(createClient).toHaveBeenCalledWith(url);
    }
  });

  it("keeps an unset TEST_DATABASE_URL skipped without constructing a client", () => {
    const createClient = vi.fn();

    expect(createDisposableTestDatabase(undefined, createClient)).toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("safe response user relations", () => {
  it("admin_order_relations_omit_credentials", async () => {
    prismaMock.order.count.mockResolvedValue(1);
    prismaMock.order.findMany.mockImplementation(async (args) => [{
      id: "order-list",
      creator: projectUser(args.include.creator, privateUser),
      assignedBarista: projectUser(args.include.assignedBarista, privateUser),
      history: [],
    }]);
    prismaMock.order.findUnique
      .mockImplementationOnce(async (args) => ({
        id: "order-detail",
        creator: projectUser(args.include.creator, privateUser),
        assignedBarista: projectUser(args.include.assignedBarista, privateUser),
        history: [],
      }))
      .mockImplementationOnce(async (args) => ({
        id: "order-null-barista",
        creator: projectUser(args.include.creator, privateUser),
        assignedBarista: projectUser(args.include.assignedBarista, null),
        history: [],
      }));
    prismaMock.$transaction.mockImplementation(async (queries) => Promise.all(queries));

    const repository = new AdminOrderRepository();
    const list = await repository.findAll();
    const detail = await repository.findById("order-detail");
    const nullBaristaDetail = await repository.findById("order-null-barista");

    for (const call of prismaMock.order.findMany.mock.calls) {
      expect(call[0].include.creator).toEqual({ select: SAFE_USER_SELECT });
      expect(call[0].include.assignedBarista).toEqual({ select: SAFE_USER_SELECT });
    }
    for (const call of prismaMock.order.findUnique.mock.calls) {
      expect(call[0].include.creator).toEqual({ select: SAFE_USER_SELECT });
      expect(call[0].include.assignedBarista).toEqual({ select: SAFE_USER_SELECT });
    }

    expectSafeSerializedUser(list.data[0].creator);
    expectSafeSerializedUser(list.data[0].assignedBarista);
    expectSafeSerializedUser(detail?.creator);
    expectSafeSerializedUser(detail?.assignedBarista);
    expect(nullBaristaDetail?.assignedBarista).toBeNull();
    expect(JSON.stringify({ list, detail, nullBaristaDetail })).not.toContain("SENTINEL_HASH");
  });

  it("audit_actor_omits_credentials", async () => {
    prismaMock.auditLog.findMany.mockImplementation(async (args) => [
      {
        id: "audit-1",
        actor: projectUser(args.include.actor, privateUser),
      },
      {
        id: "audit-2",
        actor: projectUser(args.include.actor, null),
      },
    ]);

    const logs = await new AuditService().listAuditLogs();

    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith({
      include: { actor: { select: SAFE_USER_SELECT } },
      orderBy: { createdAt: "desc" },
    });
    expectSafeSerializedUser(logs[0].actor);
    expect(logs[1].actor).toBeNull();
    expect(JSON.stringify(logs)).not.toContain("SENTINEL_HASH");
  });

  it("reconciliation_resolver_omits_credentials", async () => {
    const sepayTransaction = {
      findMany: vi.fn(async (args) => [{
        id: "transaction-list",
        resolvedBy: projectUser(args.include.resolvedBy, privateUser),
      }]),
      findUnique: vi
        .fn()
        .mockImplementationOnce(async (args) => ({
          id: "transaction-detail",
          resolvedBy: projectUser(args.include.resolvedBy, null),
        }))
        .mockImplementationOnce(async (args) => ({
          id: "reconciliation-detail",
          resolvedBy: projectUser(args.include.resolvedBy, privateUser),
        })),
      update: vi.fn(async (args) => ({
        id: "reconciliation-resolved",
        resolvedBy: projectUser(args.include.resolvedBy, privateUser),
      })),
    };
    const tx = {
      sepayTransaction: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reconciliation-resolved",
          matchStatus: TransactionMatchStatus.UNMATCHED,
          resolutionAction: ResolutionAction.NONE,
          paymentId: null,
          differenceAmount: null,
        }),
        update: sepayTransaction.update,
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: privateUser.id, role: "OWNER" }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    };
    const db = {
      sepayTransaction,
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const service = new ReconciliationService(db as never);

    const transactions = await service.listTransactions();
    const transaction = await service.getTransaction("transaction-detail");
    const reconciliations = await service.listReconciliations();
    const reconciliation = await service.getReconciliation("reconciliation-detail");
    const resolved = await service.resolveReconciliation("reconciliation-resolved", {
      resolvedByUserId: privateUser.id,
      resolutionAction: ResolutionAction.ACCEPT,
      resolutionNote: "Accept",
    });

    for (const call of sepayTransaction.findMany.mock.calls) {
      expect(call[0].include.resolvedBy).toEqual({ select: SAFE_USER_SELECT });
    }
    for (const call of sepayTransaction.findUnique.mock.calls) {
      expect(call[0].include.resolvedBy).toEqual({ select: SAFE_USER_SELECT });
    }
    expect(sepayTransaction.update.mock.calls[0][0].include.resolvedBy).toEqual({
      select: SAFE_USER_SELECT,
    });

    expectSafeSerializedUser(transactions[0].resolvedBy);
    expect(transaction.resolvedBy).toBeNull();
    expectSafeSerializedUser(reconciliations[0].resolvedBy);
    expectSafeSerializedUser(reconciliation.resolvedBy);
    expectSafeSerializedUser(resolved.resolvedBy);
    expect(JSON.stringify({ transactions, transaction, reconciliations, reconciliation, resolved }))
      .not.toContain("SENTINEL_HASH");
  });
});
