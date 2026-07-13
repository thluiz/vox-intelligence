// mcp.ts — MCP Server (Streamable HTTP transport, MCP 2024-11-05)
// Exposes vox-intelligence presets as MCP tools for Claude Code and OpenClaw.
//
// Endpoint: POST /mcp  (JSON-RPC 2.0, single or batch)
//           GET  /mcp  (SSE stream — minimal keep-alive for clients that need it)
//
// Tools:
//   suggest_annotations       — suggest annotation-worthy moments from transcript
//   podcast_episode         — process transcript → structured Vox note
//   podcast_annotate        — annotate bookmarks with transcript context
//   vision_extract_bookmarks — extract timestamps from screenshot images
//   quote_note              — compose a verified-quote Scholion note from a raw quote
//   chat                    — generic gateway call with fallback chain

import type { ProviderFactory } from "./providers/provider";
import type { Config } from "./config";
import { resolveModelChain } from "./types";
import { handlePodcastEpisode } from "./templates/podcasts/episode";
import { handlePodcastAnnotate } from "./templates/podcasts/annotate";
import { handleExtractBookmarks } from "./templates/vision/extract-bookmarks";
import { handleSuggestAnnotations } from "./templates/podcasts/suggest-annotations";
import { handleQuoteNote } from "./templates/scholion/quote-note";

// ── MCP JSON-RPC types ────────────────────────────────────────────────────────

interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "podcast_episode",
    description:
      "Process a podcast episode transcript into a structured Vox knowledge note. " +
      "Returns frontmatter fields (title, tags, participants, timeline, recommendations) " +
      "and a markdown summary ready for vox-ingest. " +
      "Use this after transcribing an episode with the whisper API.",
    inputSchema: {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          description: "Episode metadata",
          properties: {
            title: { type: "string", description: "Episode title" },
            podcast: { type: "string", description: "Podcast / show name" },
            published: { type: "string", description: "Publication date" },
            duration: { type: "string", description: "Duration e.g. '1h30m'" },
            source: { type: "string", description: "Source URL" },
          },
          required: ["title", "podcast"],
        },
        transcript: {
          type: "string",
          description: "Full transcript text (up to ~1M chars / 12h audio).",
        },
        bookmarks: {
          type: "array",
          items: { type: "string" },
          description: "Optional timestamps to annotate (e.g. ['0:12:34', '1:05:00'])",
        },
        model: {
          type: "string",
          description:
            "Override primary model (e.g. 'openrouter/openai/gpt-5.2'). Omit for default chain.",
        },
        fallbackModels: {
          type: "array",
          items: { type: "string" },
          description: "Extra fallback models after the primary",
        },
      },
      required: ["metadata", "transcript"],
    },
  },
  {
    name: "podcast_annotate",
    description:
      "Annotate podcast bookmarks with context from the transcript. " +
      "Given timestamps and a transcript, returns a rich annotation for each bookmark " +
      "explaining what was being discussed at that moment. " +
      "Use this when the user has saved bookmarks in a podcast app.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: {
          type: "string",
          description: "Full episode transcript",
        },
        bookmarks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              time: { type: "string", description: "Timestamp e.g. '1:23:45'" },
              note: { type: "string", description: "Optional user note for this bookmark" },
            },
            required: ["time"],
          },
          description: "Bookmarked timestamps to annotate",
        },
        model: { type: "string", description: "Override model" },
        fallbackModels: { type: "array", items: { type: "string" } },
      },
      required: ["transcript", "bookmarks"],
    },
  },
  {
    name: "vision_extract_bookmarks",
    description:
      "Extract podcast bookmark timestamps from screenshots. " +
      "Useful when bookmarks were saved as screenshots from a podcast app (e.g. PocketCasts). " +
      "Pass base64-encoded images; returns a list of timestamps found.",
    inputSchema: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "Base64-encoded images (JPEG/PNG), raw base64 without data: URL prefix. Each max 10MB.",
        },
        model: {
          type: "string",
          description:
            "Override vision model (default: openrouter/google/gemini-2.5-flash-lite)",
        },
        fallbackModels: { type: "array", items: { type: "string" } },
      },
      required: ["images"],
    },
  },
  {
    name: "suggest_annotations",
    description:
      "Analyze a podcast transcript and suggest annotation-worthy moments. " +
      "Returns 8-20 suggestions with timestamps, tiers (concept/data/reflection), " +
      "quotes, and overlap flags for existing annotations. " +
      "Uses a cheap model (Gemini Flash) by default — ideal for first-pass analysis.",
    inputSchema: {
      type: "object",
      properties: {
        episode: {
          type: "object",
          description: "Full episode JSON object",
          properties: {
            lang: { type: "string", description: "Language code (pt/en)" },
            summary: { type: "string", description: "Episode summary" },
            annotations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ts: { type: "string" },
                  title: { type: "string" },
                  description: { type: "string" },
                },
              },
              description: "Existing annotations",
            },
            transcript: { type: "string", description: "Full transcript text" },
            metadata: {
              type: "object",
              properties: {
                title: { type: "string" },
                podcast: { type: "string" },
                duration: { type: "string" },
              },
            },
            participants: {
              type: "array",
              items: { type: "string" },
              description: "Episode participants",
            },
          },
          required: ["transcript"],
        },
        model: { type: "string", description: "Override model" },
        fallbackModels: { type: "array", items: { type: "string" } },
      },
      required: ["episode"],
    },
  },
  {
    name: "quote_note",
    description:
      "Compose ONE verified-quote note for Scholion (mirrors the add-scholion-quote skill) " +
      "from a raw quote + presumed author. Researches authorship on the web and writes a " +
      "PT-BR note (frontmatter + body) under source-or-silence: the citation becomes the " +
      "title, the body only situates it in its source. Returns {slug, note, authorship, " +
      "lexicalWarnings} — it ONLY composes; writing to disk and git commit are the caller's " +
      "job. Run ghost-audit separately as the voice gate before publishing.",
    inputSchema: {
      type: "object",
      properties: {
        quote: {
          type: "string",
          description: "The raw citation / paraphrase to turn into a note (becomes the title).",
        },
        presumedAuthor: {
          type: "string",
          description: "Who the user believes said it — improves the authorship search.",
        },
        context: {
          type: "string",
          description:
            "Optional source/context. If it names a work (book, essay), that work is treated " +
            "as THE source and the body just situates the quote in it.",
        },
        date: {
          type: "string",
          description:
            "Frontmatter date, ISO 8601 + offset, from the real local clock " +
            "(e.g. run `date +%Y-%m-%dT%H:%M:%S%:z`). Never invented server-side.",
        },
        model: {
          type: "string",
          description: "Override primary model. Omit for the preset default chain.",
        },
        fallbackModels: { type: "array", items: { type: "string" } },
      },
      required: ["quote", "date"],
    },
  },
    {
    name: "chat",
    description:
      "Send a chat completion request through the vox-intelligence gateway. " +
      "Supports all configured providers (openrouter, ollama, openai, anthropic, deepseek) " +
      "with automatic fallback. Use when you need to route a query to a specific model " +
      "or leverage the local Ollama models without making a separate API call.",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          description: "Chat messages in OpenAI format",
        },
        model: {
          type: "string",
          description:
            "Primary model (e.g. 'openrouter/deepseek/deepseek-v3.2', 'ollama/geral'). " +
            "Omit to use the default chain.",
        },
        fallbackModels: {
          type: "array",
          items: { type: "string" },
          description: "Fallback model chain",
        },
        maxTokens: {
          type: "number",
          description: "Max output tokens (default: from config)",
        },
        temperature: {
          type: "number",
          description: "Sampling temperature 0–2",
        },
      },
      required: ["messages"],
    },
  },
];

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function ok(id: string | number | null, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── Method dispatcher ─────────────────────────────────────────────────────────

async function dispatch(
  method: string,
  params: Record<string, unknown> | undefined,
  id: string | number | null,
  factory: ProviderFactory,
  config: Config,
): Promise<MCPResponse | null> {
  switch (method) {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    case "initialize":
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "vox-intelligence", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null; // notification — no response

    case "ping":
      return ok(id, {});

    // ── Tool discovery ─────────────────────────────────────────────────────
    case "tools/list":
      return ok(id, { tools: TOOLS });

    // ── Tool invocation ────────────────────────────────────────────────────
    case "tools/call": {
      const toolName = params?.name as string | undefined;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      try {
        let resultData: unknown;

        if (toolName === "podcast_episode") {
          if (!args.metadata || !args.transcript) {
            return err(id, -32602, "Missing required args: metadata, transcript");
          }
          const { response, parsed } = await handlePodcastEpisode(
            args as any,
            factory,
            config,
          );
          resultData = { ...response, "x-parsed": parsed };

        } else if (toolName === "podcast_annotate") {
          if (!args.transcript || !args.bookmarks) {
            return err(id, -32602, "Missing required args: transcript, bookmarks");
          }
          const { response, parsed } = await handlePodcastAnnotate(
            args as any,
            factory,
            config,
          );
          resultData = { ...response, "x-parsed": parsed };

        } else if (toolName === "vision_extract_bookmarks") {
          const images = args.images;
          if (!Array.isArray(images) || images.length === 0) {
            return err(id, -32602, "Missing required args: images (non-empty array)");
          }
          const { response, parsed } = await handleExtractBookmarks(
            args as any,
            factory,
            config,
          );
          resultData = { ...response, "x-parsed": parsed };

        } else if (toolName === "suggest_annotations") {
          const episode = args.episode as Record<string, unknown> | undefined;
          if (!episode || !episode.transcript) {
            return err(id, -32602, "Missing required args: episode with transcript");
          }
          const { response, parsed } = await handleSuggestAnnotations(
            args as any,
            factory,
            config,
          );
          resultData = { ...response, "x-parsed": parsed };

        } else if (toolName === "quote_note") {
          if (!args.quote || !args.date) {
            return err(id, -32602, "Missing required args: quote, date");
          }
          resultData = await handleQuoteNote(args as any, factory, config);

        } else if (toolName === "chat") {
          if (!args.messages) {
            return err(id, -32602, "Missing required args: messages");
          }
          const modelChain = resolveModelChain(
            args.model as string | undefined,
            args.fallbackModels as string[] | undefined,
            undefined,
            config.defaultModels,
          );
          const result = await factory.completeWithFallback(
            {
              model: modelChain[0],
              messages: args.messages as any,
              maxTokens: (args.maxTokens as number) || config.maxOutputTokens,
              temperature: args.temperature as number | undefined,
            },
            modelChain,
          );
          resultData = { content: result.content, model: result.model, usage: result.usage };

        } else {
          return err(id, -32601, `Unknown tool: ${toolName ?? "(none)"}`);
        }

        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(resultData, null, 2) }],
        });

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return ok(id, {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        });
      }
    }

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ── HTTP handler (export) ─────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
};

export async function handleMCP(
  req: Request,
  factory: ProviderFactory,
  config: Config,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // GET /mcp — minimal SSE keep-alive (some clients probe this)
  if (req.method === "GET") {
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(": vox-intelligence MCP ready\n\n"));
        // Keep connection alive — client will close
      },
    });
    return new Response(body, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // POST /mcp — JSON-RPC 2.0 (single or batch)
  let body: MCPRequest | MCPRequest[];
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify(err(null, -32700, "Parse error: invalid JSON")),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const isBatch = Array.isArray(body);
  const requests: MCPRequest[] = isBatch ? body : [body as MCPRequest];

  // Dispatch all requests (notifications return null — excluded from response)
  const settled = await Promise.all(
    requests.map(r =>
      dispatch(r.method, r.params, r.id ?? null, factory, config)
    ),
  );

  const responses = settled.filter((r): r is MCPResponse => r !== null);

  if (responses.length === 0) {
    // All were notifications
    return new Response(null, { status: 202, headers: CORS });
  }

  const responseBody = isBatch ? responses : responses[0];
  return new Response(JSON.stringify(responseBody), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
