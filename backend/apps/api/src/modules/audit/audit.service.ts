import { prisma } from "../../db";
import { PUBLIC_USER_SELECT } from "../auth/public-user.select";

export class AuditService {
  public async listAuditLogs() {
    return prisma.auditLog.findMany({
      include: { actor: { select: PUBLIC_USER_SELECT } },
      orderBy: { createdAt: "desc" },
    });
  }
}

