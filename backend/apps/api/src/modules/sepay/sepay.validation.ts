import { ValidationResult } from "../orders/order.validation";
import {
  NormalizedSepayTransaction,
  normalizeSepayTransaction,
  SepayTransactionNormalizationError,
} from "./sepay-transaction";

export function parseSepayWebhook(data: unknown): NormalizedSepayTransaction {
  return normalizeSepayTransaction(data, "webhook");
}

export function validateSepayWebhook(data: unknown): ValidationResult {
  try {
    parseSepayWebhook(data);
    return { isValid: true, errors: [] };
  } catch (error) {
    if (error instanceof SepayTransactionNormalizationError) {
      return { isValid: false, errors: error.errors };
    }
    throw error;
  }
}
