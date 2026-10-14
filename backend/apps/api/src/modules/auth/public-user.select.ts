import type { Prisma } from "@prisma/client";

export const PUBLIC_USER_SELECT = {
  id: true,
  fullName: true,
  role: true,
} satisfies Prisma.UserSelect;
