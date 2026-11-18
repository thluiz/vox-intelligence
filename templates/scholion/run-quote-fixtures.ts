// Live regression for the quote-note preset: quotes that came from tweets
// (2026-11-17: the preset ignored the tweet and attributed them to books with
// no evidence; Berkopec's was pinned on McBreen "by the requester").
// Calls the running service — costs one web search + one composition per case.
//
// Usage:
//   bun templates/scholion/run-quote-fixtures.ts [baseUrl]
// Default baseUrl: http://localhost:8004. Via nginx from Windows:
//   bun templates/scholion/run-quote-fixtures.ts http://localhost:8080/api/vox-intelligence
//
// Every case checks: the sourceUrl is in sources; no forbidden string in
// body/summary/source titles; every work-kind source carries a URL, unless
// authorship.verified is false (Toscanini then saves a draft); `verified`
// matches when the case pins it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { urlKey } from "./quote-note";

interface Case {
  name: string;
  request: Record<string, unknown> & { sourceUrl: string };
  expect: { verified?: boolean; forbidden?: string[] };
}

const baseUrl = (process.argv[2] || "http://localhost:8004").replace(/\/$/, "");
const cases: Case[] = JSON.parse(
  readFileSync(join(dirname(new URL(import.meta.url).pathname), "fixtures", "quote-tweets.json"), "utf-8"),
);
const WORK_KINDS = new Set(["book", "article", "paper", "poem", "film", "podcast", "video"]);

let failures = 0;

for (const c of cases) {
  const started = Date.now();
  let out: any;
  try {
    const res = await fetch(`${baseUrl}/presets/scholion/quote-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(c.request),
    });
    if (!res.ok) {
      console.log(`✗ ${c.name} — HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      failures++;
      continue;
    }
    const body = (await res.json()) as Record<string, unknown>;
    out = body["x-parsed"] ?? body;
  } catch (err) {
    console.log(`✗ ${c.name} — request failed: ${err}`);
    failures++;
    continue;
  }

  const problems: string[] = [];
  const sources: { title: string; url?: string; kind: string }[] = out.sources ?? [];
  const text = [out.body, out.summary, ...sources.map((s) => s.title)].join("\n");

  if (!sources.some((s) => s.url && urlKey(s.url) === urlKey(c.request.sourceUrl)))
    problems.push("sourceUrl ausente de sources");
  for (const f of c.expect.forbidden ?? [])
    if (text.toLowerCase().includes(f.toLowerCase())) problems.push(`contém "${f}"`);
  if (out.authorship?.verified && sources.some((s) => WORK_KINDS.has(s.kind) && !s.url))
    problems.push("verified=true com obra sem URL");
  if (c.expect.verified !== undefined && out.authorship?.verified !== c.expect.verified)
    problems.push(`verified=${out.authorship?.verified}, esperado ${c.expect.verified}`);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const verdict = problems.length ? "✗" : "✓";
  if (problems.length) failures++;
  console.log(`${verdict} ${c.name} (${secs}s, ${out.model}) verified=${out.authorship?.verified}`);
  for (const p of problems) console.log(`    - ${p}`);
  console.log(`    body: ${String(out.body).slice(0, 300)}`);
  console.log(`    sources: ${sources.map((s) => `${s.kind}:${s.title}${s.url ? ` <${s.url}>` : ""}`).join(" | ")}`);
  if (out.provenanceWarnings?.length) console.log(`    provenance: ${out.provenanceWarnings.join(" | ")}`);
}

console.log(failures ? `\n${failures}/${cases.length} falharam` : `\n${cases.length}/${cases.length} ok`);
process.exit(failures ? 1 : 0);
