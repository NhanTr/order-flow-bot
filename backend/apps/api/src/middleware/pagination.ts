import { AppError } from "../core/errors.js";

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Parses and validates `page` and `limit` from a request query object.
 *
 * Defaults: page = 1, limit = 20.
 * Maximum limit: 100.
 *
 * Rejects:
 * - zero, negative, fractional, overflow/unsafe values
 * - junk suffixes (e.g. "10abc")
 * - empty strings
 * - repeated/array/object query values
 *
 * `limit=100` is accepted.
 *
 * @returns Validated `{ page, limit, skip }`.
 * @throws  AppError with VALIDATION_ERROR (400) on invalid input.
 */
export function parsePagination(query: unknown): PaginationParams {
  if (!query || typeof query !== "object") {
    return { page: 1, limit: 20, skip: 0 };
  }

  const raw = query as Record<string, unknown>;
  const page = parsePositiveInt(raw.page, "page", 1);
  const limit = parsePositiveInt(raw.limit, "limit", 20);

  if (limit > 100) {
    throw new AppError("VALIDATION_ERROR", "limit must not exceed 100");
  }

  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

function parsePositiveInt(
  value: unknown,
  name: string,
  defaultValue: number,
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  // Reject arrays, objects and repeated query parameters
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", `${name} must be a single string value`);
  }

  // Reject empty strings
  if (value === "") {
    throw new AppError("VALIDATION_ERROR", `${name} must not be empty`);
  }

  // Accept decimal digits only. Number() alone also accepts whitespace,
  // exponent notation and hexadecimal input, which are not valid query values.
  if (!/^[0-9]+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a valid integer`);
  }

  const num = Number(value);

  // Reject NaN (non-numeric strings)
  if (Number.isNaN(num)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a valid integer`);
  }

  // Reject Infinity/-Infinity
  if (!Number.isFinite(num)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a valid integer`);
  }

  // Reject fractional values
  if (!Number.isInteger(num)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a valid integer`);
  }

  // Reject zero and negative values
  if (num < 1) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a positive integer`);
  }

  // Reject unsafe integers (above Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(num)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a safe integer`);
  }

  return num;
}
