import { afterEach, describe, expect, it, vi } from "vitest";
import { getSeedConfig } from "../../../config/seed.config";

afterEach(() => vi.unstubAllEnvs());
describe("seed password configuration", () => {
  it("rejects passwords shorter than 12 characters without exposing the value", () => {
    const shortPassword = "short-secret".slice(0, 11);
    vi.stubEnv("SEED_OWNER_PASSWORD", shortPassword);
    let caught: unknown;
    try { getSeedConfig(); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain(shortPassword);
  });
  it("accepts a supplied password without including it in validation errors for other fields", () => {
    vi.stubEnv("SEED_OWNER_PASSWORD", "test-only-password-from-env");
    vi.stubEnv("SEED_OWNER_USERNAME", "invalid username!");
    expect(() => getSeedConfig()).toThrow();
    try { getSeedConfig(); } catch (error) {
      expect(String(error)).not.toContain("test-only-password-from-env");
    }
  });
});
