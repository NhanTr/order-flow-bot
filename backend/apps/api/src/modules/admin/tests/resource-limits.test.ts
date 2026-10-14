import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parsePagination } from "../../../middleware/pagination";
import {
  validateCreateOrder,
  validateAddItem,
  validateUpdateItem,
  validateCancelOrder,
  validateReadyOrder,
  validateDeliverOrder,
  validateOverrideStatus,
  MAX_ORDER_ITEMS,
  MAX_QUANTITY,
  MAX_NOTE_CODEPOINTS,
} from "../../orders/order.validation";
import { OrderController } from "../../orders/order.controller";
import { AdminController } from "../admin.controller";
import type { OrderService } from "../../orders/order.service";
import type { AdminService } from "../admin.service";
import { AuditController } from "../../audit/audit.controller";
import { AuditService } from "../../audit/audit.service";
import { ReconciliationController } from "../../reconciliations/reconciliation.controller";
import { ReconciliationService } from "../../reconciliations/reconciliation.service";
import { parseRevenueQuery } from "../../reports/revenue.validation";
import { RevenueExportService } from "../../reports/revenue-export.service";
import { createRequestBodyParsers } from "../../../middleware/request-limits";
import { errorHandler } from "../../../middleware/error-handler";
import { requestId } from "../../../middleware/request-id";

// ═══════════════════════════════════════════════════════════════════
//  parsePagination
// ═══════════════════════════════════════════════════════════════════
describe("parsePagination", () => {
  it("returns defaults when page and limit are absent", () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 20, skip: 0 });
    expect(parsePagination(undefined)).toEqual({ page: 1, limit: 20, skip: 0 });
    expect(parsePagination(null)).toEqual({ page: 1, limit: 20, skip: 0 });
  });

  it("accepts valid page and limit values", () => {
    expect(parsePagination({ page: "2", limit: "50" })).toEqual({ page: 2, limit: 50, skip: 50 });
  });

  it("accepts limit=100 (exact boundary)", () => {
    const result = parsePagination({ limit: "100" });
    expect(result).toEqual({ page: 1, limit: 100, skip: 0 });
  });

  it("rejects limit=101 (exceeds maximum)", () => {
    expect(() => parsePagination({ limit: "101" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects zero values", () => {
    expect(() => parsePagination({ page: "0" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ limit: "0" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects negative values", () => {
    expect(() => parsePagination({ page: "-1" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ limit: "-5" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects fractional values", () => {
    expect(() => parsePagination({ page: "1.5" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ limit: "20.1" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects overflow / unsafe integer values", () => {
    expect(() => parsePagination({ page: "9999999999999999" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ page: "Infinity" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ page: "-Infinity" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects junk suffixes", () => {
    expect(() => parsePagination({ page: "10abc" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ limit: "20xyz" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it.each([" 1 ", "1e2", "0x10"])(
    "rejects non-canonical decimal value %j",
    (value) => {
      expect(() => parsePagination({ page: value })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    },
  );

  it("rejects empty strings", () => {
    expect(() => parsePagination({ page: "" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parsePagination({ limit: "" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects repeated/array query values", () => {
    expect(() => parsePagination({ page: ["1", "2"] })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects object query values", () => {
    expect(() => parsePagination({ page: { nested: "1" } })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("computes correct skip", () => {
    expect(parsePagination({ page: "3", limit: "10" })).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(parsePagination({ page: "1", limit: "100" })).toEqual({ page: 1, limit: 100, skip: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Order input bounds — create order
// ═══════════════════════════════════════════════════════════════════
describe("validateCreateOrder bounds", () => {
  function validOrder(overrides: Record<string, unknown> = {}) {
    return {
      items: [{ menuItemId: "menu-1", quantity: 1 }],
      ...overrides,
    };
  }

  it("accepts up to 100 items", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      menuItemId: `menu-${i}`,
      quantity: 1,
    }));
    const result = validateCreateOrder({ items });
    expect(result.isValid).toBe(true);
  });

  it("rejects 101 items", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      menuItemId: `menu-${i}`,
      quantity: 1,
    }));
    const result = validateCreateOrder({ items });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("100"));
  });

  it("accepts quantity=1000 (exact boundary)", () => {
    const result = validateCreateOrder(validOrder({
      items: [{ menuItemId: "menu-1", quantity: 1000 }],
    }));
    expect(result.isValid).toBe(true);
  });

  it("rejects quantity=1001", () => {
    const result = validateCreateOrder(validOrder({
      items: [{ menuItemId: "menu-1", quantity: 1001 }],
    }));
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("1000"));
  });

  it("rejects unsafe integer quantity", () => {
    const result = validateCreateOrder(validOrder({
      items: [{ menuItemId: "menu-1", quantity: Number.MAX_SAFE_INTEGER + 1 }],
    }));
    expect(result.isValid).toBe(false);
  });

  it("accepts customerNote at exactly 2000 code points", () => {
    const note = "a".repeat(2000);
    const result = validateCreateOrder(validOrder({ customerNote: note }));
    expect(result.isValid).toBe(true);
  });

  it("rejects customerNote at 2001 code points", () => {
    const note = "a".repeat(2001);
    const result = validateCreateOrder(validOrder({ customerNote: note }));
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });

  it("counts emoji as one code point for note length", () => {
    // 🎉 is a single code point (U+1F389) but 2 UTF-16 code units
    const note = "🎉".repeat(2000);
    const result = validateCreateOrder(validOrder({ customerNote: note }));
    expect(result.isValid).toBe(true);

    const overNote = "🎉".repeat(2001);
    const overResult = validateCreateOrder(validOrder({ customerNote: overNote }));
    expect(overResult.isValid).toBe(false);
  });

  it("validates item note length", () => {
    const result = validateCreateOrder(validOrder({
      items: [{ menuItemId: "menu-1", quantity: 1, note: "a".repeat(2001) }],
    }));
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Order input bounds — add item
// ═══════════════════════════════════════════════════════════════════
describe("validateAddItem bounds", () => {
  it("rejects quantity=1001", () => {
    const result = validateAddItem({ menuItemId: "m-1", quantity: 1001 });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("1000"));
  });

  it("accepts quantity=1000", () => {
    const result = validateAddItem({ menuItemId: "m-1", quantity: 1000 });
    expect(result.isValid).toBe(true);
  });

  it("rejects unsafe integer quantity", () => {
    const result = validateAddItem({ menuItemId: "m-1", quantity: Number.MAX_SAFE_INTEGER + 1 });
    expect(result.isValid).toBe(false);
  });

  it("validates note length", () => {
    const result = validateAddItem({ menuItemId: "m-1", quantity: 1, note: "a".repeat(2001) });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Order input bounds — update item
// ═══════════════════════════════════════════════════════════════════
describe("validateUpdateItem bounds", () => {
  it("rejects quantity=1001", () => {
    const result = validateUpdateItem({ quantity: 1001 });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("1000"));
  });

  it("accepts quantity=1000", () => {
    const result = validateUpdateItem({ quantity: 1000 });
    expect(result.isValid).toBe(true);
  });

  it("preserves null note allowance", () => {
    const result = validateUpdateItem({ note: null });
    expect(result.isValid).toBe(true);
  });

  it("validates note length when string", () => {
    const result = validateUpdateItem({ note: "a".repeat(2001) });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });

  it("accepts note at exactly 2000 code points", () => {
    const result = validateUpdateItem({ note: "a".repeat(2000) });
    expect(result.isValid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Reason/note length bounds — cancel, READY, deliver, override
// ═══════════════════════════════════════════════════════════════════
describe("reason length bounds", () => {
  it("cancel: rejects reason with 2001 code points", () => {
    const result = validateCancelOrder({ reason: "a".repeat(2001) });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });

  it("cancel: accepts reason at exactly 2000 code points", () => {
    const result = validateCancelOrder({ reason: "a".repeat(2000) });
    expect(result.isValid).toBe(true);
  });

  it("ready: rejects reason with 2001 code points", () => {
    const result = validateReadyOrder({ reason: "a".repeat(2001) });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });

  it("deliver: rejects reason with 2001 code points", () => {
    const result = validateDeliverOrder({ reason: "a".repeat(2001) });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });

  it("override: rejects reason with 2001 code points", () => {
    const result = validateOverrideStatus({
      domain: "FULFILLMENT",
      status: "READY",
      reason: "a".repeat(2001),
    });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("2000"));
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Controller integration — pagination errors return 400 before service
// ═══════════════════════════════════════════════════════════════════
describe("OrderController listOrders rejects bad pagination before calling service", () => {
  let service: { getOrders: ReturnType<typeof vi.fn> };
  let controller: OrderController;
  let response: Response;
  let next: NextFunction;

  beforeEach(() => {
    service = { getOrders: vi.fn() };
    controller = new OrderController(service as unknown as OrderService);
    response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    next = vi.fn();
  });

  function requestWithQuery(query: Record<string, unknown>): Request {
    return {
      query,
      auth: { userId: "owner-1", sessionId: "session-1", role: "OWNER" },
    } as unknown as Request;
  }

  it("rejects limit=101 with 400", async () => {
    await controller.listOrders(requestWithQuery({ limit: "101" }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getOrders).not.toHaveBeenCalled();
  });

  it("rejects page=0 with 400", async () => {
    await controller.listOrders(requestWithQuery({ page: "0" }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getOrders).not.toHaveBeenCalled();
  });

  it("rejects negative limit with 400", async () => {
    await controller.listOrders(requestWithQuery({ limit: "-5" }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getOrders).not.toHaveBeenCalled();
  });

  it("rejects fractional page with 400", async () => {
    await controller.listOrders(requestWithQuery({ page: "1.5" }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getOrders).not.toHaveBeenCalled();
  });

  it("rejects junk suffix with 400", async () => {
    await controller.listOrders(requestWithQuery({ limit: "10abc" }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getOrders).not.toHaveBeenCalled();
  });

  it("accepts limit=100", async () => {
    service.getOrders.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });
    await controller.listOrders(requestWithQuery({ limit: "100" }), response, next);
    expect(service.getOrders).toHaveBeenCalled();
  });
});

describe("AdminController listOrders rejects bad pagination before calling service", () => {
  let service: { getAllOrders: ReturnType<typeof vi.fn> };
  let controller: AdminController;
  let response: Response;
  let next: NextFunction;

  beforeEach(() => {
    service = { getAllOrders: vi.fn() };
    controller = new AdminController(service as unknown as AdminService);
    response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    next = vi.fn();
  });

  function requestWithQuery(query: Record<string, unknown>): Request {
    return { query } as unknown as Request;
  }

  it("rejects limit=101 with 400", async () => {
    await controller.listOrders(requestWithQuery({ limit: "101" }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getAllOrders).not.toHaveBeenCalled();
  });

  it("rejects repeated query array with 400", async () => {
    await controller.listOrders(requestWithQuery({ page: ["1", "2"] }), response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.getAllOrders).not.toHaveBeenCalled();
  });

  it("accepts limit=100", async () => {
    service.getAllOrders.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });
    await controller.listOrders(requestWithQuery({ limit: "100" }), response, next);
    expect(service.getAllOrders).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Controller integration — input bounds reject at 400 before service
// ═══════════════════════════════════════════════════════════════════
describe("OrderController rejects bounded input at 400 before service", () => {
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let controller: OrderController;
  let response: Response;
  let next: NextFunction;

  beforeEach(() => {
    service = {
      createOrder: vi.fn(),
      addItem: vi.fn(),
      updateItem: vi.fn(),
      cancelOrder: vi.fn(),
    };
    controller = new OrderController(service as unknown as OrderService);
    response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    next = vi.fn();
  });

  it("rejects 101-item create order at 400", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      menuItemId: `menu-${i}`,
      quantity: 1,
    }));
    const req = {
      body: { items },
      auth: { userId: "staff-1", sessionId: "s1", role: "SERVICE_STAFF" },
    } as unknown as Request;
    await controller.createOrder(req, response, next);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(service.createOrder).not.toHaveBeenCalled();
  });

  it("rejects quantity=1001 in create order at 400", async () => {
    const req = {
      body: { items: [{ menuItemId: "m-1", quantity: 1001 }] },
      auth: { userId: "staff-1", sessionId: "s1", role: "SERVICE_STAFF" },
    } as unknown as Request;
    await controller.createOrder(req, response, next);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(service.createOrder).not.toHaveBeenCalled();
  });

  it("rejects 2001-character customerNote in create order at 400", async () => {
    const req = {
      body: {
        items: [{ menuItemId: "m-1", quantity: 1 }],
        customerNote: "a".repeat(2001),
      },
      auth: { userId: "staff-1", sessionId: "s1", role: "SERVICE_STAFF" },
    } as unknown as Request;
    await controller.createOrder(req, response, next);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(service.createOrder).not.toHaveBeenCalled();
  });

  it("rejects quantity=1001 in add item at 400", async () => {
    const req = {
      params: { orderId: "order-1" },
      body: { menuItemId: "m-1", quantity: 1001 },
      auth: { userId: "staff-1", sessionId: "s1", role: "SERVICE_STAFF" },
    } as unknown as Request;
    await controller.addItem(req, response, next);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(service.addItem).not.toHaveBeenCalled();
  });

  it("rejects 2001-character cancel reason at 400", async () => {
    const req = {
      params: { orderId: "order-1" },
      body: { reason: "a".repeat(2001) },
      auth: { userId: "staff-1", sessionId: "s1", role: "SERVICE_STAFF" },
    } as unknown as Request;
    await controller.cancelOrder(req, response, next);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(service.cancelOrder).not.toHaveBeenCalled();
  });
});

describe("bounded audit and reconciliation lists", () => {
  it("bounds audit reads in PostgreSQL and returns a page envelope", async () => {
    const db = {
      auditLog: {
        count: vi.fn().mockResolvedValue(43),
        findMany: vi.fn().mockResolvedValue([{ id: "audit-21" }]),
      },
    };
    const result = await new AuditService(db as never).listAuditLogs({ page: 3, limit: 10, skip: 20 });

    expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    expect(result).toEqual({ data: [{ id: "audit-21" }], total: 43, page: 3, limit: 10 });
  });

  it.each(["listTransactions", "listReconciliations"] as const)(
    "bounds %s reads in PostgreSQL and returns a page envelope",
    async (method) => {
      const db = {
        sepayTransaction: {
          count: vi.fn().mockResolvedValue(25),
          findMany: vi.fn().mockResolvedValue([{ id: "transaction-11" }]),
        },
      };
      const result = await new ReconciliationService(db as never)[method]({ page: 2, limit: 10, skip: 10 });

      expect(db.sepayTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
      expect(result).toEqual({ data: [{ id: "transaction-11" }], total: 25, page: 2, limit: 10 });
    },
  );

  it.each([
    ["audit", (service: any) => new AuditController(service).listAuditLogs],
    ["transactions", (service: any) => new ReconciliationController(service).listTransactions],
    ["reconciliations", (service: any) => new ReconciliationController(service).listReconciliations],
  ] as const)("rejects invalid %s pagination before service work", async (_name, handlerFactory) => {
    const service = {
      listAuditLogs: vi.fn(),
      listTransactions: vi.fn(),
      listReconciliations: vi.fn(),
    };
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    await handlerFactory(service)({ query: { limit: "101" } } as unknown as Request, response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(service.listAuditLogs).not.toHaveBeenCalled();
    expect(service.listTransactions).not.toHaveBeenCalled();
    expect(service.listReconciliations).not.toHaveBeenCalled();
  });
});

describe("revenue and export bounds", () => {
  it("accepts a 366-day inclusive range and rejects 367 days", () => {
    expect(() => parseRevenueQuery({ from: "2024-01-01", to: "2024-12-31" })).not.toThrow();
    expect(() => parseRevenueQuery({ from: "2024-01-01", to: "2025-01-01" })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects an export with 10001 orders before report or workbook generation", async () => {
    const db = { order: { count: vi.fn().mockResolvedValue(10_001) } };
    const reportService = { getRevenueReport: vi.fn() };
    const service = new RevenueExportService(db as never, reportService as never);

    await expect(service.export({
      format: "xlsx",
      from: new Date("2026-01-01T00:00:00+07:00"),
      to: new Date("2026-01-31T23:59:59.999+07:00"),
    })).rejects.toMatchObject({ statusCode: 413 });
    expect(reportService.getRevenueReport).not.toHaveBeenCalled();
  });
});

describe("request parser limits", () => {
  function parserApp(limit: string) {
    const app = express();
    app.use(requestId);
    for (const parser of createRequestBodyParsers({ jsonLimit: limit, urlencodedLimit: limit })) {
      app.use(parser);
    }
    app.post("/body", (req, res) => res.json({ data: req.body }));
    app.use(errorHandler);
    return app;
  }

  it("maps malformed JSON to a typed 400 without parser internals", async () => {
    const response = await request(parserApp("1kb"))
      .post("/body")
      .set("content-type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "Malformed request body" });
    expect(JSON.stringify(response.body)).not.toContain("SyntaxError");
  });

  it("maps oversized JSON to a typed 413 without echoing the body", async () => {
    const response = await request(parserApp("100b"))
      .post("/body")
      .send({ value: "x".repeat(200) });

    expect(response.status).toBe(413);
    expect(response.body.error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });
    expect(JSON.stringify(response.body)).not.toContain("xxx");
  });
});
