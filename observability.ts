/**
 * observability.ts — per-request tags for OpenRouter Broadcast
 *
 * OpenRouter forwards `user`, `session_id` and the free-form `trace` object of
 * each request to the observability destinations configured in its dashboard
 * (Langfuse, etc.). These fields are request metadata, not prompt: they cost no
 * tokens and the broadcast is sent after the response, so they add no latency.
 *
 * The route handler (server.ts) and the MCP dispatcher (mcp.ts) open a context
 * with the preset name; every OpenRouter call made inside it, however deep in
 * the fallback chain, picks the tags up without the presets passing them along.
 *
 * Callers group several requests into one session (e.g. Toscanini's suggest +
 * annotate for one episode) by sending the `x-session-id` header.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  /** Preset that originated the call, e.g. "scholion/ghost-audit", "chat". */
  preset: string;
  /** Entry point: plain HTTP route or MCP tool call. */
  via: "http" | "mcp";
  /** Caller-provided grouping id (header `x-session-id`), max 128 chars. */
  sessionId?: string;
}

const storage = new AsyncLocalStorage<CallContext>();

const MAX_SESSION_ID = 128;

/** Reads and sanitises the caller's `x-session-id` header. */
export function sessionIdFrom(req: Request): string | undefined {
  const raw = req.headers.get("x-session-id")?.trim();
  if (!raw) return undefined;
  return raw.slice(0, MAX_SESSION_ID);
}

/** Maps an HTTP path to the preset label used in traces; null = not tagged. */
export function presetFromPath(path: string): string | null {
  if (path.startsWith("/presets/")) return path.slice("/presets/".length);
  if (path === "/v1/chat/completions") return "chat";
  if (path === "/transcribe") return "transcribe/voice";
  return null;
}

/** MCP tool name → the same label its HTTP route produces. */
const MCP_TOOL_PRESETS: Record<string, string> = {
  podcast_episode: "podcast/episode",
  podcast_annotate: "podcast/annotate",
  vision_extract_bookmarks: "vision/extract-bookmarks",
  suggest_annotations: "podcast/suggest-annotations",
  quote_note: "scholion/quote-note",
  chat: "chat",
};

export function presetFromMcpTool(toolName: string | undefined): string {
  if (!toolName) return "mcp/unknown";
  return MCP_TOOL_PRESETS[toolName] ?? `mcp/${toolName}`;
}

export function withCallContext<T>(ctx: CallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentCallContext(): CallContext | undefined {
  return storage.getStore();
}

/**
 * Fields to spread into an OpenRouter request body. `step` distinguishes a
 * secondary call inside a preset (e.g. the web search of quote-note).
 * Returns {} outside a context, so untagged calls behave exactly as before.
 */
export function openRouterTraceFields(step?: string): Record<string, unknown> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const fields: Record<string, unknown> = {
    user: `vox:${ctx.preset}`,
    trace: {
      service: "vox-intelligence",
      preset: ctx.preset,
      via: ctx.via,
      ...(step ? { step } : {}),
    },
  };
  if (ctx.sessionId) fields.session_id = ctx.sessionId;
  return fields;
}
