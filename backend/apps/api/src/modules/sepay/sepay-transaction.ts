import type { Prisma } from "@prisma/client";

export const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export type SepayTransactionSource = "webhook" | "api-v1" | "api-v2";

export interface NormalizedSepayTransaction {
  externalId: string;
  accountNumber: string;
  direction: "in" | "out";
  amountIn: bigint;
  transactionDate: Date;
  content: string;
  paymentCode: string | null;
  referenceCode: string | null;
  rawPayload: Prisma.InputJsonValue;
}

export class SepayTransactionNormalizationError extends Error {
  public constructor(public readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "SepayTransactionNormalizationError";
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstDefined(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function parseExternalId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SepayTransactionNormalizationError(["transaction id must be a nonnegative safe integer, numeric string, or UUID"]);
    }
    return String(value);
  }

  if (typeof value !== "string") {
    throw new SepayTransactionNormalizationError(["transaction id is required"]);
  }

  const normalized = value.trim();
  if (
    /^\d+$/.test(normalized)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
  ) {
    return normalized;
  }

  throw new SepayTransactionNormalizationError(["transaction id must be a numeric string or UUID"]);
}

export function parseCanonicalVndAmount(value: unknown, fieldName: string): bigint {
  let normalized: string;

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SepayTransactionNormalizationError([`${fieldName} must be a nonnegative safe integer`]);
    }
    normalized = String(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const match = /^(\d+)(?:\.0+)?$/.exec(trimmed);
    if (!match) {
      throw new SepayTransactionNormalizationError([`${fieldName} must be an integer-valued decimal string`]);
    }
    normalized = match[1];
  } else {
    throw new SepayTransactionNormalizationError([`${fieldName} is required`]);
  }

  const amount = BigInt(normalized);
  if (amount > MAX_SIGNED_BIGINT) {
    throw new SepayTransactionNormalizationError([`${fieldName} exceeds signed bigint maximum`]);
  }
  return amount;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new SepayTransactionNormalizationError([`${fieldName} is required`]);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new SepayTransactionNormalizationError([`${fieldName} is required`]);
  }
  return normalized;
}

function parseOptionalString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new SepayTransactionNormalizationError([`${fieldName} must be a string or null`]);
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function parseSepayDate(value: unknown): Date {
  if (typeof value !== "string") {
    throw new SepayTransactionNormalizationError(["transaction date is required"]);
  }

  const normalized = value.trim();
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
  if (localMatch) {
    const [, year, month, day, hour, minute, second] = localMatch;
    const timestamp = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 7,
      Number(minute),
      Number(second),
    );
    const date = new Date(timestamp);
    const local = new Date(timestamp + 7 * 60 * 60 * 1_000);
    if (
      local.getUTCFullYear() !== Number(year)
      || local.getUTCMonth() !== Number(month) - 1
      || local.getUTCDate() !== Number(day)
      || local.getUTCHours() !== Number(hour)
      || local.getUTCMinutes() !== Number(minute)
      || local.getUTCSeconds() !== Number(second)
    ) {
      throw new SepayTransactionNormalizationError(["transaction date is invalid"]);
    }
    return date;
  }

  const zonedMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(normalized);
  if (!zonedMatch) {
    throw new SepayTransactionNormalizationError(["transaction date must include seconds and an explicit timezone"]);
  }
  const [, year, month, day, hour, minute, second] = zonedMatch;
  const maxDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1
    || Number(month) > 12
    || Number(day) < 1
    || Number(day) > maxDay
    || Number(hour) > 23
    || Number(minute) > 59
    || Number(second) > 59
  ) {
    throw new SepayTransactionNormalizationError(["transaction date is invalid"]);
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new SepayTransactionNormalizationError(["transaction date is invalid"]);
  }
  return new Date(timestamp);
}

function jsonPayload(payload: UnknownRecord): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
}

function directionAndAmount(payload: UnknownRecord, source: SepayTransactionSource) {
  const explicitDirection = firstDefined(payload, ["transferType", "transfer_type"]);
  if (explicitDirection !== undefined) {
    if (explicitDirection !== "in" && explicitDirection !== "out") {
      throw new SepayTransactionNormalizationError(["transfer type must be in or out"]);
    }
    const amountValue = firstDefined(payload, [
      "transferAmount",
      "transfer_amount",
      explicitDirection === "in" ? "amount_in" : "amount_out",
      "amountIn",
      "amount",
    ]);
    return {
      direction: explicitDirection,
      amountIn: parseCanonicalVndAmount(amountValue, "transfer amount"),
    } as const;
  }

  if (source === "webhook") {
    throw new SepayTransactionNormalizationError(["transfer type is required"]);
  }

  const amountIn = parseCanonicalVndAmount(firstDefined(payload, ["amount_in", "amountIn"]), "amount_in");
  const amountOut = parseCanonicalVndAmount(firstDefined(payload, ["amount_out", "amountOut"]), "amount_out");
  if (amountIn > 0n && amountOut === 0n) return { direction: "in" as const, amountIn };
  if (amountOut > 0n && amountIn === 0n) return { direction: "out" as const, amountIn: amountOut };
  throw new SepayTransactionNormalizationError(["transaction must contain exactly one positive incoming or outgoing amount"]);
}

export function normalizeSepayTransaction(
  payload: unknown,
  source: SepayTransactionSource,
): NormalizedSepayTransaction {
  if (!isRecord(payload)) {
    throw new SepayTransactionNormalizationError(["transaction payload must be an object"]);
  }

  const { direction, amountIn } = directionAndAmount(payload, source);
  if (amountIn === 0n) {
    throw new SepayTransactionNormalizationError(["transaction amount must be greater than zero"]);
  }

  return {
    externalId: parseExternalId(firstDefined(payload, [
      "sepayTransactionId",
      "sepay_transaction_id",
      "transactionId",
      "transaction_id",
      "id",
    ])),
    accountNumber: parseRequiredString(firstDefined(payload, ["accountNumber", "account_number"]), "account number"),
    direction,
    amountIn,
    transactionDate: parseSepayDate(firstDefined(payload, ["transactionDate", "transaction_date", "transferDate"])),
    content: parseRequiredString(firstDefined(payload, ["content", "transaction_content", "description"]), "transaction content"),
    paymentCode: parseOptionalString(firstDefined(payload, ["code", "paymentCode", "payment_code"]), "payment code"),
    referenceCode: parseOptionalString(firstDefined(payload, [
      "referenceCode",
      "reference_code",
      "reference_number",
      "reference",
    ]), "reference code"),
    rawPayload: jsonPayload(payload),
  };
}
