import type {
  ChatMessage,
  PodcastAnnotateRequest,
  PodcastAnnotation,
  OpenAIChatResponse,
} from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

const SYSTEM_PROMPT = `You are a specialist in analyzing podcast transcripts and generating annotations for bookmarked moments.

You receive a full transcript and a list of timestamps (bookmarks). For each bookmark, read the transcript context around +-60 seconds of the marked timestamp, understand what is being discussed, and produce:
- A concise title (5-10 words) capturing the topic at that moment
- A brief summary (1-3 sentences) of the key point, insight, or discussion

IMPORTANT RULES:
- Base ALL output strictly on the provided transcript. Do not invent, infer, or hallucinate information that is not present in the input
- Output ONLY valid JSON, no markdown fences, no commentary
- Write in the same language as the transcript
- Each annotation must reference the exact timestamp provided
- When multiple bookmarks are within 30 seconds of each other and cover the same topic, merge them into a single annotation — use the earliest timestamp, but read context from 60s before the first bookmark to 60s after the last bookmark in the cluster, as this typically indicates a longer topic with multiple key points
- If a timestamp doesn't clearly correspond to transcript content, provide best-effort annotation based on surrounding context

OUTPUT SCHEMA:
[
  {
    "time": "HH:MM:SS",
    "title": "string — concise title",
    "description": "string — 1-3 sentence description"
  }
]`;

function buildUserPrompt(req: PodcastAnnotateRequest): string {
  const parts: string[] = [];

  parts.push("## Bookmarks to annotate");
  for (const bm of req.bookmarks) {
    if (bm.note) {
      parts.push(`- ${bm.time} — ${bm.note}`);
    } else {
      parts.push(`- ${bm.time}`);
    }
  }

  parts.push("");
  parts.push("## Full Transcript");
  parts.push(req.transcript);

  return parts.join("\n");
}

function parseResponse(content: string): PodcastAnnotation[] {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array of annotations");
  }

  return parsed.map((item: Record<string, unknown>) => ({
    time: String(item.time || "00:00:00"),
    title: String(item.title || ""),
    description: String(item.description || ""),
  }));
}

export async function handlePodcastAnnotate(
  req: PodcastAnnotateRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<{ response: OpenAIChatResponse; parsed: PodcastAnnotation[] }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];

  const modelChain = resolveModelChain(req.model, req.fallbackModels, undefined, config.defaultModels);

  const result = await factory.completeWithFallback(
    {
      model: "",
      messages,
      maxTokens: config.maxOutputTokens,
      temperature: 0.3,
    },
    modelChain,
  );

  const parsed = parseResponse(result.content);

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

  return { response, parsed };
}
