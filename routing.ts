// Model chain per use case, owned by Toscanini (Toscanini.ModelRouting).
//
// Each preset asks presetChain("<case key>", PRESET_MODELS). The answer comes from
// GET /api/orchestrator/model-routing/resolved, cached for 60 s; Toscanini asks for an
// immediate refresh (POST /routing/refresh) whenever the table changes. When Toscanini
// cannot be reached, the last good answer keeps serving; with no answer at all, the
// constant passed by the preset is used. Those constants mirror the third-party profile,
// so a Toscanini outage never sends traffic somewhere unexpected.

const ROUTING_URL =
  process.env.MODEL_ROUTING_URL || "http://localhost:8080/api/orchestrator/model-routing/resolved";
const TTL_MS = 60_000;
const RETRY_MS = 15_000;
const TIMEOUT_MS = 2_000;

export interface RoutingSnapshot {
  profile: string | null;
  chains: Record<string, string[]>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (url, init) => fetch(url, init);
let cached: { at: number; ttl: number; snap: RoutingSnapshot | null } | null = null;
let inflight: Promise<RoutingSnapshot | null> | null = null;

async function fetchSnapshot(): Promise<RoutingSnapshot | null> {
  try {
    const res = await fetcher(ROUTING_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as RoutingSnapshot;
    if (!body || typeof body.chains !== "object" || body.chains === null) throw new Error("malformed body");
    return body;
  } catch (e) {
    console.warn(`[routing] Toscanini unreachable: ${(e as Error).message}`);
    return null;
  }
}

async function snapshot(): Promise<RoutingSnapshot | null> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.snap;
  if (!inflight) {
    inflight = fetchSnapshot().then((fresh) => {
      const previous = cached?.snap ?? null;
      // A failed fetch keeps the last good table instead of dropping to the constants.
      const snap = fresh ?? previous;
      if (fresh && fresh.profile !== previous?.profile) {
        console.log(`[routing] profile: ${fresh.profile}`);
      }
      cached = { at: Date.now(), ttl: fresh ? TTL_MS : RETRY_MS, snap };
      inflight = null;
      return snap;
    });
  }
  return inflight;
}

/** Chain for `key` in the active profile, or `fallback` when Toscanini has none. */
export async function presetChain(key: string, fallback: string[]): Promise<string[]> {
  const chain = (await snapshot())?.chains?.[key];
  return Array.isArray(chain) && chain.length > 0 ? [...chain] : [...fallback];
}

/** The global chain (case C12, key "default"). */
export function globalChain(fallback: string[]): Promise<string[]> {
  return presetChain("default", fallback);
}

/** Mark the cache stale so the next call asks Toscanini again. The table itself is
 *  kept, so a refresh followed by a Toscanini outage still serves the last good one. */
export function refreshRouting(): void {
  if (cached) cached.at = 0;
}

export async function routingStatus(): Promise<{
  source: "toscanini" | "preset-constants";
  profile: string | null;
  chains: Record<string, string[]>;
}> {
  const snap = await snapshot();
  return { source: snap ? "toscanini" : "preset-constants", profile: snap?.profile ?? null, chains: snap?.chains ?? {} };
}

/** Test hook: replace fetch and clear all state. */
export function __setFetcherForTests(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
  cached = null;
  inflight = null;
}

