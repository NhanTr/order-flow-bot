const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateReport } = require("./audit-runtime.cjs");

const approvedWaiver = {
  packages: ["prisma", "@prisma/config", "deepmerge-ts"],
  advisory: "GHSA-ggr8-5vv4-36mx",
  owner: "Order Flow maintainers",
  expires: "2027-01-31",
  reason: "Build-only recursive merge behavior",
};

function report(advisory = "GHSA-ggr8-5vv4-36mx") {
  return {
    vulnerabilities: {
      prisma: { severity: "high", via: ["@prisma/config"] },
      "@prisma/config": { severity: "high", via: ["deepmerge-ts"] },
      "deepmerge-ts": {
        severity: "high",
        via: [{ url: `https://github.com/advisories/${advisory}` }],
      },
    },
  };
}

test("waives only the exact documented advisory through transitive findings", () => {
  const result = evaluateReport("backend", report(), { waivers: [approvedWaiver] }, new Date("2026-10-15T00:00:00Z"));
  assert.equal(result.failed, false);
  assert.deepEqual(result.waived.map((finding) => finding.packageName).sort(), [
    "@prisma/config",
    "deepmerge-ts",
    "prisma",
  ]);
});

test("does not let a package waiver hide an unrelated advisory", () => {
  const result = evaluateReport("backend", report("GHSA-new-unrelated-risk"), { waivers: [approvedWaiver] }, new Date("2026-10-15T00:00:00Z"));
  assert.equal(result.failed, true);
  assert.deepEqual(result.unwaived.map((finding) => finding.advisories), [
    ["GHSA-NEW-UNRELATED-RISK"],
    ["GHSA-NEW-UNRELATED-RISK"],
    ["GHSA-NEW-UNRELATED-RISK"],
  ]);
});

test("expired or incomplete waivers fail closed", () => {
  const expired = { ...approvedWaiver, expires: "2026-10-14" };
  const incomplete = { ...approvedWaiver, owner: "" };
  assert.equal(evaluateReport("backend", report(), { waivers: [expired] }, new Date("2026-10-15T00:00:00Z")).failed, true);
  assert.equal(evaluateReport("backend", report(), { waivers: [incomplete] }, new Date("2026-10-15T00:00:00Z")).failed, true);
});
