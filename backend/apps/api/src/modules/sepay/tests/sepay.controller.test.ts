import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../../../middleware/error-handler.js";
import { SepayController } from "../sepay.controller";
import { createSepayRouter } from "../sepay.routes";

afterEach(() => vi.unstubAllEnvs());

describe("SePay webhook HTTP contract", () => {
  it("returns the success flag required by SePay", async () => {
    const handleWebhook = vi.fn().mockResolvedValue({
      duplicate: false,
      matched: true,
      transactionId: "transaction-1",
      paymentId: "payment-1",
      matchStatus: "MATCHED",
    });
    const controller = new SepayController({ handleWebhook } as any);
    const req: any = { body: { id: 92704, transferAmount: 30_000 }, headers: {} };
    const json = vi.fn();
    const res: any = { status: vi.fn().mockReturnValue({ json }) };

    await controller.handleWebhook(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, ok: true, matched: true }));
  });

  it("returns HTTP 401 for a wrong SePay API key", async () => {
    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "correct-key");
    const app = express();
    app.use(express.json());
    app.use("/webhook", createSepayRouter());
    app.use(errorHandler);

    const response = await request(app)
      .post("/webhook")
      .set("Authorization", "Apikey wrong-key")
      .send({ id: 92704, transferAmount: 30_000, content: "PAYUNKNOWN" });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns HTTP 503 before body validation when the webhook key is missing", async () => {
    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "");
    vi.stubEnv("SEPAY_WEBHOOK_SECRET", "");
    vi.stubEnv("NODE_ENV", "test");
    const app = express();
    app.use(express.json());
    app.use("/webhook", createSepayRouter());
    app.use(errorHandler);

    const response = await request(app)
      .post("/webhook")
      .send({ transferAmount: "invalid" });

    expect(response.status).toBe(503);
  });

  it("returns HTTP 400 for an authenticated malformed webhook", async () => {
    vi.stubEnv("SEPAY_WEBHOOK_API_KEY", "correct-key");
    vi.stubEnv("SEPAY_BANK_ACCOUNT", "1017588888");
    const app = express();
    app.use(express.json());
    app.use("/webhook", createSepayRouter());
    app.use(errorHandler);

    const response = await request(app)
      .post("/webhook")
      .set("Authorization", "Apikey correct-key")
      .send({
        id: 92704,
        transactionDate: "not-a-date",
        accountNumber: "1017588888",
        content: "PAYUNKNOWN",
        transferType: "in",
        transferAmount: 30_000,
      });

    expect(response.status).toBe(400);
  });
});
