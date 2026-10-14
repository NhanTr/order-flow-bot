import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildUpstreamHeaders,
  requireSameOriginMutation,
  upstreamTimeoutMs,
  validateBackendRoute,
} from "../src/lib/request-security";
import { canAccessAdminPath, visibleNavigationFor } from "../src/lib/access-policy";
import { POST as login } from "../src/app/api/auth/login/route";
import {
  collectPaginated,
  confirmCash,
  createOrder,
  initQrPayment,
  refundOrder,
  resolveReconciliation,
} from "../src/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("same-origin browser mutations", () => {
  const origin = "https://orders.example.com";

  it("allows reads and exact same-origin mutations", () => {
    expect(() => requireSameOriginMutation(new Request(`${origin}/api/backend/orders`), origin)).not.toThrow();
    expect(() => requireSameOriginMutation(new Request(`${origin}/api/backend/orders`, {
      method: "POST",
      headers: { origin },
    }), origin)).not.toThrow();
  });

  it.each([undefined, "null", "https://evil.example"])(
    "rejects a mutation with Origin=%s",
    (provided) => {
      const headers = provided === undefined ? undefined : { origin: provided };
      expect(() => requireSameOriginMutation(new Request(`${origin}/api/backend/orders`, {
        method: "POST",
        headers,
      }), origin)).toThrowError(/origin/i);
    },
  );
});

describe("trusted BFF routing", () => {
  it("allows business routes but blocks token endpoints and path traversal", () => {
    expect(validateBackendRoute(["orders", "order-1"], "GET")).toEqual("orders/order-1");
    expect(validateBackendRoute(["menu", "items"], "GET")).toEqual("menu/items");
    expect(validateBackendRoute(["admin", "auth", "me"], "GET")).toEqual("admin/auth/me");
    expect(() => validateBackendRoute(["admin", "auth", "refresh"], "POST")).toThrow();
    expect(() => validateBackendRoute(["admin", "auth", "login"], "POST")).toThrow();
    expect(() => validateBackendRoute(["..", "admin", "auth", "me"], "GET")).toThrow();
    expect(() => validateBackendRoute(["orders%2Fsecret"], "GET")).toThrow();
  });

  it("strips caller proxy headers and adds only the authenticated BFF identity", () => {
    const request = new Request("https://orders.example.com/api/backend/orders", {
      headers: {
        authorization: "Bearer attacker",
        "x-order-flow-client-ip": "203.0.113.55",
        "x-order-flow-proxy-secret": "attacker-secret",
        "content-type": "application/json",
      },
    });
    const headers = buildUpstreamHeaders(request, {
      accessToken: "server-token",
      proxySecret: "trusted-secret",
      clientIp: "198.51.100.7",
    });
    expect(headers.get("authorization")).toBe("Bearer server-token");
    expect(headers.get("x-order-flow-client-ip")).toBe("198.51.100.7");
    expect(headers.get("x-order-flow-proxy-secret")).toBe("trusted-secret");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("uses the longer timeout only for the explicit report export", () => {
    expect(upstreamTimeoutMs(["orders"], "GET")).toBe(15_000);
    expect(upstreamTimeoutMs(["admin", "reports", "revenue", "export"], "POST")).toBe(60_000);
  });

  it("rejects cross-origin login before fetch and sanitizes invalid upstream JSON", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://orders.example.com");
    vi.stubEnv("API_PROXY_SECRET", "proxy-secret-at-least-32-characters");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rejected = await login(new Request("https://orders.example.com/api/auth/login", { method: "POST" }));
    expect(rejected.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response("accessToken=secret-token", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const invalid = await login(new Request("https://orders.example.com/api/auth/login", {
      method: "POST",
      headers: { origin: "https://orders.example.com", "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "password" }),
    }));
    expect(invalid.status).toBe(502);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(await invalid.text()).not.toContain("secret-token");
  });
});

describe("role-aware UI policy", () => {
  it("lets service staff use only their order pages", () => {
    expect(canAccessAdminPath("SERVICE_STAFF", "/orders")).toBe(true);
    expect(canAccessAdminPath("SERVICE_STAFF", "/orders/new")).toBe(true);
    expect(canAccessAdminPath("SERVICE_STAFF", "/orders/order-1")).toBe(true);
    expect(canAccessAdminPath("SERVICE_STAFF", "/payments")).toBe(false);
    expect(canAccessAdminPath("SERVICE_STAFF", "/audit")).toBe(false);
    expect(visibleNavigationFor("SERVICE_STAFF").map((item) => item.href)).toEqual(["/orders"]);
  });

  it("allows owners and denies baristas from web administration", () => {
    expect(canAccessAdminPath("OWNER", "/audit")).toBe(true);
    expect(canAccessAdminPath("BARISTA", "/orders")).toBe(false);
  });
});

describe("paginated frontend contracts", () => {
  it("loads records beyond the first 100 and stops on an empty last page", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => index),
      Array.from({ length: 100 }, (_, index) => index + 100),
      [200],
      [],
    ];
    const requested: number[] = [];
    const result = await collectPaginated(async (page, limit) => {
      requested.push(page);
      return { data: pages[page - 1] ?? [], total: 999, page, limit };
    }, 100);
    expect(result).toHaveLength(201);
    expect(requested).toEqual([1, 2, 3, 4]);
  });
});

describe("actor-free browser requests", () => {
  it("does not send actor identifiers for order, payment, refund, or reconciliation mutations", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await createOrder({ paymentMethod: "CASH", items: [{ menuItemId: "item-1", quantity: 1 }] });
    await confirmCash("order-1", { amount: 1000 });
    await initQrPayment("order-1");
    await refundOrder("order-1", { amount: 1000, reason: "duplicate" });
    await resolveReconciliation("tx-1", { resolutionAction: "ACCEPT", resolutionNote: "checked" });

    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(/createdByUserId|confirmedByUserId|requestedByUserId|refundedByUserId|resolvedByUserId/);
    }
  });
});
