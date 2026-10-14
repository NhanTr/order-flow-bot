import { PaymentMethod, FulfillmentStatus, PaymentStatus } from "./order.types";

// ── Shared validation constants ──────────────────────────────────
export const MAX_ORDER_ITEMS  = 100;
export const MAX_QUANTITY     = 1000;
export const MAX_NOTE_CODEPOINTS = 2000;

/**
 * Returns the number of Unicode code points in the string.
 * Correctly handles surrogate pairs (e.g. emoji).
 */
function codePointLength(str: string): number {
  // Spread uses the string iterator which yields code points.
  let count = 0;
  for (const _ of str) count++;
  return count;
}

function validateQuantity(quantity: unknown, path: string, errors: string[]): void {
  if (
    typeof quantity !== "number" ||
    quantity < 1 ||
    !Number.isInteger(quantity)
  ) {
    errors.push(`${path} must be a positive integer`);
    return;
  }
  if (!Number.isSafeInteger(quantity)) {
    errors.push(`${path} must be a safe integer`);
    return;
  }
  if (quantity > MAX_QUANTITY) {
    errors.push(`${path} must not exceed ${MAX_QUANTITY}`);
  }
}

function validateNoteLength(note: string, path: string, errors: string[]): void {
  if (codePointLength(note) > MAX_NOTE_CODEPOINTS) {
    errors.push(`${path} must not exceed ${MAX_NOTE_CODEPOINTS} characters`);
  }
}

export interface ValidationResult {
  isValid: boolean;
  errors:  string[];
}

/**
 * Validates POST /api/v1/orders body.
 */
export function validateCreateOrder(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Request body is required"] };
  }

  if (
    data.paymentMethod !== undefined &&
    !Object.values(PaymentMethod).includes(data.paymentMethod)
  ) {
    errors.push(`paymentMethod must be one of: ${Object.values(PaymentMethod).join(", ")}`);
  }

  if (!Array.isArray(data.items) || data.items.length === 0) {
    errors.push("items must be a non-empty array");
  } else {
    if (data.items.length > MAX_ORDER_ITEMS) {
      errors.push(`items must not exceed ${MAX_ORDER_ITEMS}`);
    }
    data.items.forEach((item: any, idx: number) => {
      if (!item.menuItemId || typeof item.menuItemId !== "string") {
        errors.push(`items[${idx}].menuItemId is required`);
      }
      validateQuantity(item.quantity, `items[${idx}].quantity`, errors);
      if (item.note !== undefined) {
        if (typeof item.note !== "string") {
          errors.push(`items[${idx}].note must be a string`);
        } else {
          validateNoteLength(item.note, `items[${idx}].note`, errors);
        }
      }
    });
  }

  if (data.customerNote !== undefined && typeof data.customerNote !== "string") {
    errors.push("customerNote must be a string");
  }
  if (typeof data.customerNote === "string") {
    validateNoteLength(data.customerNote, "customerNote", errors);
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validates POST /api/v1/orders/:orderId/items body.
 */
export function validateAddItem(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Request body is required"] };
  }

  if (!data.menuItemId || typeof data.menuItemId !== "string") {
    errors.push("menuItemId is required");
  }
  validateQuantity(data.quantity, "quantity", errors);
  if (data.note !== undefined) {
    if (typeof data.note !== "string") {
      errors.push("note must be a string");
    } else {
      validateNoteLength(data.note, "note", errors);
    }
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validates PATCH /api/v1/orders/:orderId/items/:itemId body.
 */
export function validateUpdateItem(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Request body is required"] };
  }

  if (data.quantity !== undefined) {
    validateQuantity(data.quantity, "quantity", errors);
  }

  if (data.note !== undefined && data.note !== null && typeof data.note !== "string") {
    errors.push("note must be a string or null");
  }
  if (typeof data.note === "string") {
    validateNoteLength(data.note, "note", errors);
  }

  const updatableFields = ["quantity", "note"];
  if (!updatableFields.some((f) => f in data)) {
    errors.push("At least one of quantity or note must be provided");
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validates POST /api/v1/orders/:orderId/cancel body.
 * `reason` is mandatory — enforced by the SQL cancellation_reason_chk constraint.
 */
export function validateCancelOrder(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data?.reason || typeof data.reason !== "string" || data.reason.trim() === "") {
    errors.push("reason is required when cancelling an order");
  } else {
    validateNoteLength(data.reason, "reason", errors);
  }

  return { isValid: errors.length === 0, errors };
}

export function validateReadyOrder(data: any): ValidationResult {
  if (typeof data?.reason !== "string" || data.reason.trim() === "") {
    return { isValid: false, errors: ["reason is required for an owner READY override"] };
  }
  const errors: string[] = [];
  validateNoteLength(data.reason, "reason", errors);
  return { isValid: errors.length === 0, errors };
}

export function validateDeliverOrder(data: any): ValidationResult {
  if (data?.reason !== undefined && typeof data.reason !== "string") {
    return { isValid: false, errors: ["reason must be a string when provided"] };
  }
  const errors: string[] = [];
  if (typeof data?.reason === "string") {
    validateNoteLength(data.reason, "reason", errors);
  }
  return { isValid: errors.length === 0, errors };
}

/**
 * Validates POST /api/v1/admin/orders/:orderId/override-status body.
 */
export function validateOverrideStatus(data: any): ValidationResult {
  const errors: string[] = [];

  const DOMAINS    = ["PAYMENT", "FULFILLMENT"];
  const F_STATUSES = Object.values(FulfillmentStatus);
  const P_STATUSES = Object.values(PaymentStatus);

  if (!data?.domain || !DOMAINS.includes(data.domain)) {
    errors.push(`domain must be one of: ${DOMAINS.join(", ")}`);
    return { isValid: false, errors };
  }

  const validStatuses = data.domain === "FULFILLMENT" ? F_STATUSES : P_STATUSES;
  if (!data.status || !(validStatuses as string[]).includes(data.status)) {
    errors.push(`status for domain ${data.domain} must be one of: ${validStatuses.join(", ")}`);
  }

  if (!data.reason || typeof data.reason !== "string" || data.reason.trim() === "") {
    errors.push("reason is required");
  } else {
    validateNoteLength(data.reason, "reason", errors);
  }

  return { isValid: errors.length === 0, errors };
}
