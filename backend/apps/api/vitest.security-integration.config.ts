import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/modules/orders/tests/web-lifecycle.security.integration.test.ts",
      "src/modules/refunds/tests/refund.security.integration.test.ts",
      "src/modules/sepay/tests/sepay.security.integration.test.ts",
    ],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
