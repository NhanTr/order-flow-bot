import { z } from "zod";
import { parseRevenueQuery, type RevenueQuery } from "./revenue.validation";

export const revenueExportFormatSchema = z.enum([
  "xlsx",
]);

const exportBodySchema = z.object({ format: z.literal("xlsx") });

export type RevenueExportFormat = z.infer<typeof revenueExportFormatSchema>;
export type RevenueExportInput = RevenueQuery & { format: "xlsx" };

export function parseRevenueExportInput(query: unknown, body: unknown): RevenueExportInput {
  const range = parseRevenueQuery(query);
  const parsed = exportBodySchema.parse(body);
  return { ...range, ...parsed } as RevenueExportInput;
}
