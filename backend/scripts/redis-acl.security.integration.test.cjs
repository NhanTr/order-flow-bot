const assert = require("node:assert/strict");
const test = require("node:test");
const { Queue } = require("bullmq");
const { createClient } = require("redis");

const apiUrl = process.env.TEST_REDIS_API_URL;
const bffUrl = process.env.TEST_REDIS_BFF_URL;
const workerUrl = process.env.TEST_REDIS_WORKER_URL;
const adminUrl = process.env.TEST_REDIS_ADMIN_URL;
const enabled = Boolean(apiUrl && bffUrl && workerUrl && adminUrl);

function assertDisposableUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(host), "test Redis must use loopback");
  assert.ok(url.port && url.port !== "6379", "test Redis must use a non-default disposable port");
}

async function client(url) {
  const value = createClient({ url, socket: { connectTimeout: 1_000 } });
  value.on("error", () => undefined);
  await value.connect();
  return value;
}

test("Redis ACLs isolate API, BFF and BullMQ namespaces", { skip: !enabled }, async () => {
  [apiUrl, bffUrl, workerUrl, adminUrl].forEach(assertDisposableUrl);
  const api = await client(apiUrl);
  const bff = await client(bffUrl);
  const worker = await client(workerUrl);
  const admin = await client(adminUrl);
  const queue = new Queue("telegram-notifications", { connection: { url: workerUrl } });
  try {
    await api.set("order-flow:auth-session:v1:test", "ok");
    await api.eval("return redis.call('SET', KEYS[1], ARGV[1])", {
      keys: ["order-flow:security:v1:test"], arguments: ["ok"],
    });
    await assert.rejects(api.get("order-flow:bff-refresh:v1:test"), /NOPERM/);

    await bff.set("order-flow:bff-refresh:v1:test", "ok");
    await assert.rejects(bff.get("order-flow:auth-session:v1:test"), /NOPERM/);

    const job = await queue.add("security-test", { ok: true }, { jobId: "security-test" });
    assert.equal((await queue.getJob(job.id)).id, job.id);
    await assert.rejects(worker.get("order-flow:auth-session:v1:test"), /NOPERM/);
  } finally {
    await queue.close();
    await admin.del([
      "order-flow:auth-session:v1:test",
      "order-flow:security:v1:test",
      "order-flow:bff-refresh:v1:test",
    ]).catch(() => undefined);
    for await (const key of admin.scanIterator({ MATCH: "bull:telegram-notifications:*", COUNT: 100 })) {
      await admin.del(key);
    }
    await Promise.allSettled([api.quit(), bff.quit(), worker.quit(), admin.quit()]);
  }
});
