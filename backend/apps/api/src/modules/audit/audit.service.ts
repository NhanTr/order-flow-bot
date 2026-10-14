import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../db";
import type { PaginationParams } from "../../middleware/pagination";
import { PUBLIC_USER_SELECT } from "../auth/public-user.select";

export class AuditService {
  constructor(private readonly db: PrismaClient = prisma) {}

  public async listAuditLogs(pagination: PaginationParams = { page: 1, limit: 20, skip: 0 }) {
    const [data, total] = await Promise.all([
      this.db.auditLog.findMany({
        include: { actor: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: "desc" },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.db.auditLog.count(),
    ]);
    return { data, total, page: pagination.page, limit: pagination.limit };
  }
}

