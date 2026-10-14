import createHttpError from "http-errors";
import {
  AuditEntityType,
  Prisma,
  PrismaClient,
  ResolutionAction,
  TransactionMatchStatus,
} from "@prisma/client";
import { prisma } from "../../db";
import { PUBLIC_USER_SELECT } from "../auth/public-user.select";
import type { PaginationParams } from "../../middleware/pagination";

export interface ResolveReconciliationInput {
  resolvedByUserId: string;
  resolutionAction: ResolutionAction;
  resolutionNote: string;
}

export class ReconciliationService {
  constructor(private readonly db: PrismaClient = prisma) {}

  public async listTransactions(pagination: PaginationParams = { page: 1, limit: 20, skip: 0 }) {
    const [data, total] = await Promise.all([
      this.db.sepayTransaction.findMany({
        include: {
          payment: { include: { order: true } },
          resolvedBy: { select: PUBLIC_USER_SELECT },
        },
        orderBy: { receivedAt: "desc" },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.db.sepayTransaction.count(),
    ]);
    return { data, total, page: pagination.page, limit: pagination.limit };
  }

  public async getTransaction(transactionId: string) {
    const transaction = await this.db.sepayTransaction.findUnique({
      where: { id: transactionId },
      include: {
        payment: { include: { order: true } },
        resolvedBy: { select: PUBLIC_USER_SELECT },
      },
    });

    if (!transaction) throw createHttpError(404, `Transaction ${transactionId} not found`);
    return transaction;
  }

  public async listReconciliations(pagination: PaginationParams = { page: 1, limit: 20, skip: 0 }) {
    const where = {
        OR: [
          { matchStatus: TransactionMatchStatus.UNMATCHED },
          { matchStatus: TransactionMatchStatus.WRONG_CODE },
        ],
      };
    const [data, total] = await Promise.all([
      this.db.sepayTransaction.findMany({
        where,
        include: {
          payment: { include: { order: true } },
          resolvedBy: { select: PUBLIC_USER_SELECT },
        },
        orderBy: { receivedAt: "desc" },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.db.sepayTransaction.count({ where }),
    ]);
    return { data, total, page: pagination.page, limit: pagination.limit };
  }

  public async getReconciliation(reconciliationId: string) {
    const reconciliation = await this.db.sepayTransaction.findUnique({
      where: { id: reconciliationId },
      include: {
        payment: { include: { order: true } },
        resolvedBy: { select: PUBLIC_USER_SELECT },
      },
    });

    if (!reconciliation) {
      throw createHttpError(404, `Reconciliation ${reconciliationId} not found`);
    }

    return reconciliation;
  }

  public async resolveReconciliation(
    reconciliationId: string,
    input: ResolveReconciliationInput
  ) {
    return this.db.$transaction(async (tx: Prisma.TransactionClient) => {
      const [reconciliation, user] = await Promise.all([
        tx.sepayTransaction.findUnique({ where: { id: reconciliationId } }),
        tx.user.findUnique({ where: { id: input.resolvedByUserId } }),
      ]);

      if (!reconciliation) {
        throw createHttpError(404, `Reconciliation ${reconciliationId} not found`);
      }
      if (!user) {
        throw createHttpError(404, `User ${input.resolvedByUserId} not found`);
      }
      if (user.role !== "OWNER") {
        throw createHttpError(403, "Only owner can resolve reconciliation records");
      }

      const resolved = await tx.sepayTransaction.update({
        where: { id: reconciliationId },
        data: {
          matchStatus: TransactionMatchStatus.REVIEWED,
          resolutionAction: input.resolutionAction,
          resolutionNote: input.resolutionNote.trim(),
          resolvedByUserId: input.resolvedByUserId,
          resolvedAt: new Date(),
        },
        include: {
          payment: { include: { order: true } },
          resolvedBy: { select: PUBLIC_USER_SELECT },
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.resolvedByUserId,
          action: "RECONCILIATION_RESOLVED",
          entityType: AuditEntityType.SEPAY_TRANSACTION,
          entityId: reconciliationId,
          details: {
            previousMatchStatus: reconciliation.matchStatus,
            newMatchStatus: TransactionMatchStatus.REVIEWED,
            previousResolutionAction: reconciliation.resolutionAction,
            resolutionAction: input.resolutionAction,
            resolutionNote: input.resolutionNote.trim(),
            paymentId: reconciliation.paymentId,
            differenceAmount: reconciliation.differenceAmount?.toString() ?? null,
          },
        },
      });

      return resolved;
    });
  }
}
