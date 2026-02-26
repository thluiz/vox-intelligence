import type {
  ChatMessage,
  PodcastEpisodeRequest,
  PodcastEpisodeParsed,
  OpenAIChatResponse,
} from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

const SYSTEM_PROMPT = `You are a specialist in analyzing podcast episodes and generating structured metadata.
You receive episode metadata and a transcript, and produce a structured JSON response.

IMPORTANT RULES:
- Base ALL output strictly on the provided metadata and transcript. Do not invent, infer, or hallucinate information that is not present in the input
- The one exception is the title field: if the title cannot be clearly determined from the metadata, derive a clean, descriptive title from the transcript content (do NOT output "undefined" or leave it blank)
- Output ONLY valid JSON, no markdown fences, no commentary
- All text fields must be in the same language as the transcript (detect automatically)
- Tags must be lowercase ASCII kebab-case (no accents — e.g. "tapajos" not "tapajós"), in order of relevance, up to 10
- Participants: extract only the names of hosts and guests who actively speak or participate in the conversation. Do NOT include people who are merely mentioned, discussed, quoted, or referenced as third parties
- Timeline: key moments with timestamps from the transcript. For each entry, include a brief summary (2-4 sentences) describing the discussion at that point — similar to a bookmark annotation
- Recommendations: group by category (e.g. books, articles, tools, people, movies, places, podcasts, music — use whatever categories are relevant to the episode content). Only include categories that have entries. For each item, provide a title and a brief description of what was said about it in the episode
- Summary: 3-5 paragraphs covering the main topics discussed
- Description: 1-2 sentences for metadata/SEO (og:description)
- Annotations: if bookmarks are provided, generate an annotation for each bookmark timestamp. Read the transcript context around +-60 seconds of the marked timestamp, understand what is being discussed, and produce a title and brief summary. When multiple bookmarks are within 30 seconds of each other and cover the same topic, merge them into a single annotation — use the earliest timestamp, but read context from 60s before the first bookmark to 60s after the last bookmark in the cluster, as this typically indicates a longer topic with multiple key points. If no bookmarks section is present, omit the annotations field entirely

OUTPUT SCHEMA:
{
  "title": "string — clean episode title without podcast name or episode number prefix. If not present in metadata, derive from transcript",
  "description": "string — 1-2 sentence summary for metadata",
  "aliases": ["string[] — alternative titles or common abbreviations found in the transcript or metadata, NOT the episode number"],
  "participants": ["string[] — full names of host(s) and guest(s)"],
  "tags": ["string[] — up to 10 most relevant tags in kebab-case, in order of relevance"],
  "lang": "string — 'pt' or 'en' (detected from transcript)",
  "summary": "string — 3-5 paragraph markdown summary",
  "timeline": [{"time": "HH:MM:SS", "topic": "string — brief title (5-10 words)", "summary": "string — 2-4 sentence description of what is discussed at this point"}],
  "recommendations": {"<category>": [{"title": "string — item name", "description": "string — 1-2 sentences about what was said about this item in the episode"}]},
  "annotations": [{"time": "HH:MM:SS", "title": "string — concise title (5-10 words)", "description": "string — 1-3 sentence description"}]
}`;

function buildUserPrompt(req: PodcastEpisodeRequest): string {
  const parts: string[] = [];

  parts.push("## Episode Metadata");
  parts.push(`Title: ${req.metadata.title}`);
  parts.push(`Podcast: ${req.metadata.podcast}`);
  if (req.metadata.published) parts.push(`Published: ${req.metadata.published}`);
  if (req.metadata.duration) parts.push(`Duration: ${req.metadata.duration}`);
  if (req.metadata.source) parts.push(`Source: ${req.metadata.source}`);

  if (req.bookmarks && req.bookmarks.length > 0) {
    parts.push("");
    parts.push("## Bookmarks (user-marked important moments)");
    parts.push(req.bookmarks.join(", "));
  }

  parts.push("");
  parts.push("## Transcript");
  parts.push(req.transcript);

  return parts.join("\n");
}

function parseResponse(content: string): PodcastEpisodeParsed {
  // Strip markdown fences if present
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  // Validate required fields
  const required = ["title", "description", "summary", "lang"] as const;
  for (const field of required) {
    if (!parsed[field] || typeof parsed[field] !== "string") {
      throw new Error(`Missing or invalid required field: ${field}`);
    }
  }

  const rawRec = parsed.recommendations || {};
  const recommendations: Record<string, { title: string; description: string }[]> = {};
  for (const [cat, items] of Object.entries(rawRec)) {
    if (!Array.isArray(items)) continue;
    recommendations[cat] = (items as Record<string, unknown>[]).map((item) => ({
      title: String(item.title ?? ""),
      description: String(item.description ?? ""),
    }));
  }

  return {
    title: parsed.title,
    description: parsed.description,
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
    participants: Array.isArray(parsed.participants) ? parsed.participants : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    lang: parsed.lang,
    summary: parsed.summary,
    timeline: Array.isArray(parsed.timeline)
      ? parsed.timeline.map((t: Record<string, unknown>) => ({
          time: String(t.time || "00:00:00"),
          topic: String(t.topic || ""),
          summary: String(t.summary || ""),
        }))
      : [],
    recommendations,
    annotations: Array.isArray(parsed.annotations)
      ? parsed.annotations.map((a: Record<string, unknown>) => ({
          time: String(a.time || "00:00:00"),
          title: String(a.title || ""),
          description: String(a.description || ""),
        }))
      : undefined,
  };
}

export async function handlePodcastEpisode(
  req: PodcastEpisodeRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<{ response: OpenAIChatResponse; parsed: PodcastEpisodeParsed }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];

  const modelChain = resolveModelChain(req.model, req.fallbackModels, undefined, config.defaultModels);

  const result = await factory.completeWithFallback(
    {
      model: "", // will be overridden by fallback chain
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
