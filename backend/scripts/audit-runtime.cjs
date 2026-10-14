const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..", "..");

function advisoryIds(packageName, vulnerabilities, seen = new Set()) {
  if (seen.has(packageName)) return [];
  seen.add(packageName);
  const finding = vulnerabilities[packageName];
  if (!finding) return [];
  const ids = [];
  for (const via of finding.via ?? []) {
    if (typeof via === "string") {
      ids.push(...advisoryIds(via, vulnerabilities, seen));
      continue;
    }
    const match = typeof via.url === "string" ? via.url.match(/\/advisories\/(GHSA-[A-Za-z0-9-]+)/i) : null;
    if (match) ids.push(match[1].toUpperCase());
  }
  return [...new Set(ids)].sort();
}

function activeDocumentedWaiver(entry, packageName, advisory, now) {
  return Array.isArray(entry.packages)
    && entry.packages.includes(packageName)
    && typeof entry.advisory === "string"
    && entry.advisory.toUpperCase() === advisory
    && typeof entry.owner === "string"
    && entry.owner.trim().length > 0
    && typeof entry.reason === "string"
    && entry.reason.trim().length > 0
    && typeof entry.expires === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.expires)
    && new Date(`${entry.expires}T23:59:59Z`) >= now;
}

function evaluateReport(target, report, policy, now = new Date()) {
  const waived = [];
  const unwaived = [];
  for (const [packageName, finding] of Object.entries(report.vulnerabilities ?? {})) {
    if (!["high", "critical"].includes(finding.severity)) continue;
    const advisories = advisoryIds(packageName, report.vulnerabilities ?? {});
    const matchingWaivers = advisories.map((advisory) =>
      (policy.waivers ?? []).find((entry) => activeDocumentedWaiver(entry, packageName, advisory, now)),
    );
    const waiver = matchingWaivers[0];
    const record = { target, packageName, severity: finding.severity, advisories, waiver };
    if (advisories.length > 0 && matchingWaivers.every(Boolean)) waived.push(record);
    else unwaived.push(record);
  }
  return { failed: unwaived.length > 0, waived, unwaived };
}

function auditTargets(targets) {
  if (targets.length === 0) throw new Error("Pass one or more package directories to audit-runtime.cjs");
  const policy = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "docs/security-advisory-waivers.json"), "utf8"));
  const now = new Date();
  let failed = false;

  for (const target of targets) {
    const cwd = path.resolve(repositoryRoot, target);
    let output;
    try {
      output = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = error.stdout;
      if (!output) throw error;
    }
    const result = evaluateReport(target, JSON.parse(output), policy, now);
    for (const finding of result.waived) {
      console.warn(`WAIVED ${finding.severity} ${finding.packageName} until ${finding.waiver.expires}: ${finding.waiver.advisory}`);
    }
    for (const finding of result.unwaived) {
      failed = true;
      const advisory = finding.advisories.length > 0 ? ` (${finding.advisories.join(", ")})` : "";
      console.error(`UNWAIVED ${finding.severity} dependency finding: ${target} -> ${finding.packageName}${advisory}`);
    }
  }

  if (failed) process.exitCode = 1;
  else console.info("No unwaived high or critical runtime dependency findings");
}

if (require.main === module) auditTargets(process.argv.slice(2));

module.exports = { advisoryIds, auditTargets, evaluateReport };
