import { loadConfig } from "./config";
import { ProviderFactory, parseModelString } from "./providers/provider";
import { handlePodcastEpisode } from "./templates/podcasts/episode";
import { handlePodcastAnnotate } from "./templates/podcasts/annotate";
import { handleExtractBookmarks } from "./templates/vision/extract-bookmarks";
import { handleHolographicDialog } from "./templates/dialog/holographic";
import { handleSuggestAnnotations } from "./templates/podcasts/suggest-annotations";
import { handleVoiceTranscribe } from "./templates/transcribe/voice";
import { handleMeetingSummarize } from "./templates/meetings/summarize-master-course";
import { handleGhostAudit } from "./templates/quality/ghost-audit";
import { handleEtymologyNote } from "./templates/scholion/etymology-note";
import { handleQuoteNote } from "./templates/scholion/quote-note";
import type { OpenAIChatRequest, OpenAIChatResponse, ExtractBookmarksRequest } from "./types";
import { getTextContent } from "./types";
import { handleMCP } from "./mcp";

const config = loadConfig();
const factory = new ProviderFactory(config);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: { message, type: "invalid_request_error" } }, status);
}

// Guard: reject inputs that exceed the largest available context window (GPT-5.2 400K tokens).
// ~3 chars/token for mixed content, minus 16K tokens reserved for output = ~1,150,000 chars.
// Rounded down to 1,000,000 for safety. Fallback to smaller models would only waste money
// and hallucinate — better to reject early with a clear message.
const MAX_INPUT_CHARS = 1_000_000;

function validateInputSize(transcript: string, extra = 0): string | null {
  const totalChars = transcript.length + extra;
  if (totalChars > MAX_INPUT_CHARS) {
    const hours = Math.round(totalChars / 1330 / 60 * 10) / 10; // rough estimate at 1330 chars/min
    return `Input too large: ${(totalChars / 1000).toFixed(0)}K chars (~${hours}h of audio). ` +
      `Maximum supported: ${(MAX_INPUT_CHARS / 1000).toFixed(0)}K chars (~12.5h). ` +
      `Consider splitting the transcript into parts.`;
  }
  return null;
}

async function handleChatCompletions(body: OpenAIChatRequest): Promise<Response> {
  if (!body.model || !body.messages?.length) {
    return errorResponse("Missing required fields: model, messages");
  }

  const totalContent = body.messages.reduce((sum, m) => sum + getTextContent(m).length, 0);
  const sizeError = validateInputSize("", totalContent);
  if (sizeError) return errorResponse(sizeError, 413);

  const maxTokens = body.max_completion_tokens || body.max_tokens || config.maxOutputTokens;

  // Build model chain: primary + fallback
  const modelChain = [body.model];
  if (body["x-fallback-models"]) {
    modelChain.push(...body["x-fallback-models"]);
  }

  try {
    const result = await factory.completeWithFallback(
      {
        model: body.model,
        messages: body.messages,
        maxTokens,
        temperature: body.temperature,
        reasoning: body.reasoning,
      },
      modelChain,
    );

    const id = `vi-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const response: OpenAIChatResponse = {
      id,
      object: "chat.completion",
      model: result.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.content },
        finish_reason: result.finishReason === "length" ? "length" : "stop",
      }],
      usage: result.usage ? {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      } : undefined,
    };

    return jsonResponse(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 502);
  }
}

async function handlePresetPodcastEpisode(body: unknown): Promise<Response> {
  const req = body as Record<string, unknown>;
  if (!req.metadata || !req.transcript) {
    return errorResponse("Missing required fields: metadata, transcript");
  }

  const sizeError = validateInputSize(String(req.transcript), JSON.stringify(req.metadata).length);
  if (sizeError) return errorResponse(sizeError, 413);

  try {
    const { response, parsed } = await handlePodcastEpisode(
      req as any,
      factory,
      config,
    );

    return jsonResponse({ ...response, "x-parsed": parsed });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 502);
  }
}

async function handlePresetPodcastAnnotate(body: unknown): Promise<Response> {
  const req = body as Record<string, unknown>;
  if (!req.transcript || !req.bookmarks) {
    return errorResponse("Missing required fields: transcript, bookmarks");
  }

  const sizeError = validateInputSize(String(req.transcript));
  if (sizeError) return errorResponse(sizeError, 413);

  try {
    const { response, parsed } = await handlePodcastAnnotate(
      req as any,
      factory,
      config,
    );

    return jsonResponse({ ...response, "x-parsed": parsed });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 502);
  }
}


async function handlePresetHolographicDialog(body: unknown): Promise<Response> {
  const req = body as Record<string, unknown>;
  if (!req.episode || !req.message) {
    return errorResponse("Missing required fields: episode, message");
  }

  try {
    const result = await handleHolographicDialog(
      req as any,
      factory,
      config,
    );
    return jsonResponse(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 502);
  }
}


async function handlePresetSuggestAnnotations(body: unknown): Promise<Response> {
  const req = body as Record<string, unknown>;
  const episode = req.episode as Record<string, unknown> | undefined;
  if (!episode || !episode.transcript) {
    return errorResponse("Missing required fields: episode with transcript");
  }

  const sizeError = validateInputSize(String(episode.transcript));
  if (sizeError) return errorResponse(sizeError, 413);

  try {
    const { response, parsed } = await handleSuggestAnnotations(
      req as any,
      factory,
      config,
    );

    return jsonResponse({ ...response, "x-parsed": parsed });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 502);
  }
}

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (path === "/health" && req.method === "GET") {
      const providers: string[] = [];
      if (config.openrouterApiKey) providers.push("openrouter");
      providers.push("ollama");
      if (config.openaiApiKey) providers.push("openai");
      if (config.anthropicApiKey) providers.push("anthropic");
      if (config.deepseekApiKey) providers.push("deepseek");

      return jsonResponse({
        ok: true,
        service: "vox-intelligence",
        providers,
        defaultModels: config.defaultModels,
      });
    }

    // Generic chat completions (OpenAI-compatible)
    if (path === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json() as OpenAIChatRequest;
        return handleChatCompletions(body);
      } catch {
        return errorResponse("Invalid JSON body");
      }
    }

    // Preset: podcast episode
    if (path === "/presets/podcast/episode" && req.method === "POST") {
      try {
        const body = await req.json();
        return handlePresetPodcastEpisode(body);
      } catch {
        return errorResponse("Invalid JSON body");
      }
    }

    // Preset: podcast annotate
    if (path === "/presets/podcast/annotate" && req.method === "POST") {
      try {
        const body = await req.json();
        return handlePresetPodcastAnnotate(body);
      } catch {
        return errorResponse("Invalid JSON body");
      }
    }

    // Preset: vision extract-bookmarks
    if (path === "/presets/vision/extract-bookmarks" && req.method === "POST") {
      try {
        const body = await req.json() as ExtractBookmarksRequest;

        if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
          return errorResponse("Missing required field: images (non-empty array of base64 strings)");
        }

        // Validate each image: must be a string, max 10MB base64 (~7.5MB decoded)
        const MAX_IMAGE_B64 = 10 * 1024 * 1024; // ~10MB base64
        for (let i = 0; i < body.images.length; i++) {
          if (typeof body.images[i] !== "string") {
            return errorResponse(`images[${i}] must be a base64 string`);
          }
          if (body.images[i].length > MAX_IMAGE_B64) {
            return errorResponse(`images[${i}] exceeds 10MB limit`, 413);
          }
        }

        const { response, parsed } = await handleExtractBookmarks(body, factory, config);
        return jsonResponse({ ...response, "x-parsed": parsed });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Invalid JSON") || msg.includes("JSON Parse")) {
          return errorResponse("Invalid JSON body");
        }
        return errorResponse(msg, 502);
      }
    }

    // Preset: suggest annotations
    if (path === "/presets/podcast/suggest-annotations" && req.method === "POST") {
      try {
        const body = await req.json();
        return handlePresetSuggestAnnotations(body);
      } catch {
        return errorResponse("Invalid JSON body");
      }
    }

        // Preset: holographic dialog (Scholion)
    if (path === "/presets/holographic-dialog" && req.method === "POST") {
      try {
        const body = await req.json();
        return handlePresetHolographicDialog(body);
      } catch {
        return errorResponse("Invalid JSON body");
      }
    }

    // Voice transcription (Scholion)
    if (path === "/transcribe" && req.method === "POST") {
      try {
        const form = await req.formData();
        const file = form.get("file") as File | null;
        if (!file) return errorResponse("Missing file field");
        const buffer = await file.arrayBuffer();
        const { transcript, model } = await handleVoiceTranscribe(buffer, file.name, config);
        return jsonResponse({ text: transcript, model });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(msg, 502);
      }
    }

    // MCP endpoint (Streamable HTTP transport)
    if (path === "/mcp") {
      return handleMCP(req, factory, config);
    }

    // Preset: meeting summarize (master course encounters)
    if (path === "/presets/meeting/summarize-master-course" && req.method === "POST") {
      try {
        const body = await req.json() as Record<string, unknown>;
        if (!body.metadata || !body.transcript) {
          return errorResponse("Missing required fields: metadata, transcript");
        }
        const sizeError = validateInputSize(String(body.transcript), JSON.stringify(body.metadata).length);
        if (sizeError) return errorResponse(sizeError, 413);
        const { response, parsed } = await handleMeetingSummarize(body as any, factory, config);
        return jsonResponse({ ...response, "x-parsed": parsed });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(msg, 502);
      }
    }

    // Preset: Chinese etymology note synthesis (Scholion radicals pipeline)
    if (path === "/presets/scholion/etymology-note" && req.method === "POST") {
      try {
        const body = await req.json() as Record<string, unknown>;
        for (const field of ["char", "radicalNum", "hex", "date", "gabarito", "dump"]) {
          if (!body[field]) return errorResponse(`Missing required field: ${field}`);
        }
        const sizeError = validateInputSize(String(body.dump), String(body.gabarito).length);
        if (sizeError) return errorResponse(sizeError, 413);
        const result = await handleEtymologyNote(body as any, factory, config);
        return jsonResponse(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("JSON Parse")) return errorResponse("Invalid JSON body");
        return errorResponse(msg, 502);
      }
    }

    // Preset: verified-quote note synthesis (Scholion add-scholion-quote)
    if (path === "/presets/scholion/quote-note" && req.method === "POST") {
      try {
        const body = await req.json() as Record<string, unknown>;
        if (!body.quote || typeof body.quote !== "string") {
          return errorResponse("Missing required field: quote");
        }
        if (!body.date || typeof body.date !== "string") {
          return errorResponse("Missing required field: date (ISO 8601 + offset, caller's clock)");
        }
        const sizeError = validateInputSize(String(body.quote), String(body.context || "").length);
        if (sizeError) return errorResponse(sizeError, 413);
        const result = await handleQuoteNote(body as any, factory, config);
        return jsonResponse(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("JSON Parse")) return errorResponse("Invalid JSON body");
        return errorResponse(msg, 502);
      }
    }

    // Preset: ghost-writer voice audit (Scholion)
    if (path === "/presets/scholion/ghost-audit" && req.method === "POST") {
      try {
        const body = await req.json() as Record<string, unknown>;
        if (!body.content || typeof body.content !== "string") {
          return errorResponse("Missing required field: content");
        }
        if (body.content.length > 200000) {
          return errorResponse("Note too large for audit", 413);
        }
        const { response, parsed } = await handleGhostAudit(body as any, factory, config);
        return jsonResponse({ ...response, "x-parsed": parsed });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(msg, 502);
      }
    }

    return errorResponse("Not found", 404);
  },
});

console.log(`[vox-intelligence] Running on port ${server.port}`);
console.log(`[vox-intelligence] Providers: ${[
  config.openrouterApiKey ? "openrouter" : null,
  "ollama",
  config.openaiApiKey ? "openai" : null,
  config.anthropicApiKey ? "anthropic" : null,
  config.deepseekApiKey ? "deepseek" : null,
].filter(Boolean).join(", ")}`);
console.log(`[vox-intelligence] Default models: ${config.defaultModels.join(" → ")}`);
