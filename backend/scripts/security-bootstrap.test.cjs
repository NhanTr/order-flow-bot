const assert = require("node:assert/strict");
const test = require("node:test");

const { quoteLiteral, runtimePassword, safeErrorMessage } = require("./security-bootstrap.cjs");

test("runtime passwords must be long and URL-safe", () => {
  assert.equal(runtimePassword("PASSWORD", { PASSWORD: "Api_runtime-password.2026" }), "Api_runtime-password.2026");
  assert.throws(() => runtimePassword("PASSWORD", { PASSWORD: "short" }), /at least 24/);
  assert.throws(() => runtimePassword("PASSWORD", { PASSWORD: "contains/slash-and-is-long-enough" }), /URL-safe/);
});

test("SQL literals escape quotes defensively", () => {
  assert.equal(quoteLiteral("one'two"), "'one''two'");
});

test("bootstrap errors redact database URLs and password fields", () => {
  const result = safeErrorMessage(new Error("connect postgresql://admin:secret@db/prod password=secret"));
  assert.equal(result.includes("secret"), false);
  assert.match(result, /redacted/);
});
