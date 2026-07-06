// Regression eval for the ghost-audit preset. Posts each fixture note to the
// running service and checks verdict + expected rules. Run after prompt edits
// or model swaps — this is how "gpt-5.2 catches source-or-silence" stays a
// tested fact instead of folklore.
//
// Usage:
//   bun templates/quality/run-fixtures.ts [baseUrl]
// Default baseUrl: http://localhost:8004 (direct). Via nginx from Windows:
//   bun templates/quality/run-fixtures.ts http://localhost:8080/api/vox-intelligence

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

interface Expectation {
  file: string;
  verdict: string[];
  mustIncludeRules?: string[];
  mustIncludeAnyRule?: string[];
}

const baseUrl = (process.argv[2] || "http://localhost:8004").replace(/\/$/, "");
const fixturesDir = join(dirname(new URL(import.meta.url).pathname), "fixtures");
const expectations: Expectation[] = JSON.parse(
  readFileSync(join(fixturesDir, "expected.json"), "utf-8"),
);

let failures = 0;

for (const exp of expectations) {
  const content = readFileSync(join(fixturesDir, exp.file), "utf-8");
  const started = Date.now();
  let parsed: { verdict: string; findings: Array<{ rule: string; severity: string; line: number | null; quote: string }>; summary: string };

  try {
    const res = await fetch(`${baseUrl}/presets/scholion/ghost-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ content, slug: `fixture/${exp.file}` }),
    });
    if (!res.ok) {
      console.log(`✗ ${exp.file} — HTTP ${res.status}: ${await res.text()}`);
      failures++;
      continue;
    }
    const body = (await res.json()) as Record<string, unknown>;
    parsed = body["x-parsed"] as typeof parsed;
  } catch (err) {
    console.log(`✗ ${exp.file} — request failed: ${err}`);
    failures++;
    continue;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const rules = parsed.findings.map((f) => f.rule);
  const problems: string[] = [];

  if (!exp.verdict.includes(parsed.verdict)) {
    problems.push(`verdict "${parsed.verdict}" (esperado: ${exp.verdict.join("|")})`);
  }
  for (const rule of exp.mustIncludeRules ?? []) {
    if (!rules.includes(rule)) problems.push(`regra ausente: ${rule}`);
  }
  if (exp.mustIncludeAnyRule && !exp.mustIncludeAnyRule.some((r) => rules.includes(r))) {
    problems.push(`nenhuma das regras esperadas: ${exp.mustIncludeAnyRule.join(", ")}`);
  }
  const unlocated = parsed.findings.filter((f) => f.line === null);
  if (unlocated.length > 0) {
    problems.push(`${unlocated.length} finding(s) com quote não localizado (line: null)`);
  }

  if (problems.length === 0) {
    console.log(`✓ ${exp.file} — ${parsed.verdict}, ${parsed.findings.length} finding(s), ${elapsed}s`);
  } else {
    failures++;
    console.log(`✗ ${exp.file} — ${problems.join("; ")} [${elapsed}s]`);
    for (const f of parsed.findings) {
      console.log(`    [${f.severity}] ${f.rule} L${f.line ?? "?"}: "${f.quote.slice(0, 80)}"`);
    }
    if (parsed.summary) console.log(`    summary: ${parsed.summary}`);
  }
}

console.log(failures === 0 ? "\nTodas as fixtures passaram." : `\n${failures} fixture(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
