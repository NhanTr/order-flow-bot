import createHttpError from "http-errors";

import type { AccessIdentity } from "./auth.types";

export type OrderAccessAction = "read" | "edit" | "cancel" | "pay" | "deliver";

export function assertOrderAccess(
  actor: AccessIdentity,
  order: { createdByUserId: string },
  _action: OrderAccessAction,
): void {
  if (actor.role === "OWNER") return;
  if (actor.role === "SERVICE_STAFF" && order.createdByUserId === actor.userId) return;

  throw createHttpError(403, "You do not have access to this order");
}