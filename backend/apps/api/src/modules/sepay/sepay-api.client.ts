import {
  NormalizedSepayTransaction,
  normalizeSepayTransaction,
  SepayTransactionNormalizationError,
} from "./sepay-transaction";

export interface SepayTransactionLookupInput {
  accountNumber: string;
  amount: bigint;
  paymentCode: string;
  createdAt: Date;
}

export interface SepayTransactionLookup {
  findIncomingTransaction(input: SepayTransactionLookupInput): Promise<NormalizedSepayTransaction | null>;
}

export class SepayApiClientError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SepayApiClientError";
  }
}


function sepayLocalDateTime(value: Date): string {
  return new Date(value.getTime() + 7 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

export class SepayApiClient implements SepayTransactionLookup {
  public constructor(
    private readonly apiToken: string = process.env.SEPAY_API_TOKEN?.trim() ?? "",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = process.env.SEPAY_API_BASE_URL?.trim()
      || "https://my.sepay.vn/userapi/transactions/list",
  ) {}

  public async findIncomingTransaction(input: SepayTransactionLookupInput): Promise<NormalizedSepayTransaction | null> {
    if (!this.apiToken) {
      throw new SepayApiClientError(503, "SEPAY_API_NOT_CONFIGURED", "SePay API token is not configured");
    }

    const url = new URL(this.baseUrl);
    const isV2 = /\/v2\/transactions\/?$/.test(url.pathname);
    if (isV2) {
      url.searchParams.set("q", input.paymentCode);
      url.searchParams.set("amount_in_min", input.amount.toString());
      url.searchParams.set("amount_in_max", input.amount.toString());
      url.searchParams.set("transfer_type", "in");
      url.searchParams.set(
        "transaction_date_from",
        sepayLocalDateTime(new Date(input.createdAt.getTime() - 60_000)),
      );
      url.searchParams.set("transaction_date_sort", "desc");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("timestamp_format", "iso8601");
    } else {
      url.searchParams.set("account_number", input.accountNumber);
      url.searchParams.set("amount_in", input.amount.toString());
      url.searchParams.set("transaction_date_min", input.createdAt.toISOString().slice(0, 10));
      url.searchParams.set("limit", "100");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SepayApiClientError(502, "SEPAY_API_UNAVAILABLE", "Cannot connect to SePay transaction API");
    }

    if (!response.ok) {
      throw new SepayApiClientError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        response.status === 401 || response.status === 403 ? "SEPAY_API_TOKEN_INVALID" : "SEPAY_API_UNAVAILABLE",
        `SePay transaction API returned HTTP ${response.status}`,
      );
    }

    const payload = await response.json().catch(() => null) as {
      data?: unknown[];
      transactions?: unknown[];
    } | null;
    const transactions = isV2 ? payload?.data : payload?.transactions;
    if (!Array.isArray(transactions)) {
      throw new SepayApiClientError(502, "SEPAY_API_RESPONSE_INVALID", "SePay transaction API returned invalid data");
    }

    let normalizedTransactions: NormalizedSepayTransaction[];
    try {
      normalizedTransactions = transactions.map((transaction) => normalizeSepayTransaction(
        transaction,
        isV2 ? "api-v2" : "api-v1",
      ));
    } catch (error) {
      if (error instanceof SepayTransactionNormalizationError) {
        throw new SepayApiClientError(502, "SEPAY_API_RESPONSE_INVALID", "SePay transaction API returned invalid data");
      }
      throw error;
    }

    const paymentCode = input.paymentCode.toUpperCase();
    return normalizedTransactions.find((candidate) => {
      const content = candidate.content.toUpperCase();
      const code = candidate.paymentCode?.toUpperCase() ?? "";
      return (
        candidate.accountNumber === input.accountNumber
        && candidate.amountIn === input.amount
        && candidate.direction === "in"
        && (code === paymentCode || content.includes(paymentCode))
        && candidate.transactionDate.getTime() >= input.createdAt.getTime() - 60_000
      );
    }) ?? null;
  }
}
