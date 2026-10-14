import type { NextFunction, Request, Response } from "express";
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
