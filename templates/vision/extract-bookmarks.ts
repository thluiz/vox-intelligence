import type { ProviderFactory } from "../../providers/provider";
import type { Config } from "../../config";
import type {
  ChatMessage,
  ContentPart,
  ImageContentPart,
  ExtractBookmarksRequest,
  ExtractBookmarksResult,
} from "../../types";
import { resolveModelChain } from "../../types";

const SYSTEM_PROMPT = `You are an OCR assistant that extracts timestamps from podcast player screenshots.

The user will send one or more screenshots from a podcast player app (e.g., Pocket Casts). Each screenshot shows a list of bookmarks/clips with timestamps.

Your task:
1. Read ALL visible timestamps from the screenshots
2. Return them as a JSON array in the EXACT format shown below
3. Timestamps must be in MM:SS or HH:MM:SS format exactly as shown in the screenshot
4. Include ALL timestamps visible across ALL images — do not skip any
5. Order timestamps from highest (latest in episode) to lowest (earliest)
6. Remove duplicates if the same timestamp appears in multiple screenshots

Return ONLY valid JSON, no markdown fences, no explanation:
{"bookmarks": <count>, "timestamps": ["MM:SS", ...]}`;

const DEFAULT_VISION_MODELS = [
  "openrouter/google/gemini-2.5-flash-lite",
  "openrouter/openai/gpt-4o-mini",
  "openrouter/anthropic/claude-sonnet-4",
];

function detectMediaType(base64: string): ImageContentPart["mediaType"] {
  // Check magic bytes from base64 prefix
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lGO")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  // Default to jpeg (most common for photos)
  return "image/jpeg";
}

function buildMessages(images: string[]): ChatMessage[] {
  const userParts: ContentPart[] = [
    { type: "text", text: `Extract all timestamps from these ${images.length} screenshot(s).` },
  ];

  for (const img of images) {
    userParts.push({
      type: "image",
      mediaType: detectMediaType(img),
      data: img,
    });
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userParts },
  ];
}

function parseResponse(raw: string): ExtractBookmarksResult {
  // Strip markdown fences if present
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(text);

  if (!Array.isArray(parsed.timestamps)) {
    throw new Error("Response missing 'timestamps' array");
  }

  // Validate each timestamp matches MM:SS or HH:MM:SS
  const validTimestamp = /^\d{1,2}:\d{2}(:\d{2})?$/;
  for (const ts of parsed.timestamps) {
    if (typeof ts !== "string" || !validTimestamp.test(ts)) {
      throw new Error(`Invalid timestamp format: "${ts}"`);
    }
  }

  return {
    bookmarks: parsed.timestamps.length,
    timestamps: parsed.timestamps,
  };
}

export async function handleExtractBookmarks(
  req: ExtractBookmarksRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<{ response: { content: string; model: string }; parsed: ExtractBookmarksResult }> {
  const messages = buildMessages(req.images);

  const modelChain = resolveModelChain(req.model, req.fallbackModels, DEFAULT_VISION_MODELS, config.defaultModels);

  const result = await factory.completeWithFallback(
    {
      model: modelChain[0],
      messages,
      maxTokens: 1000,
      temperature: 0.1,
    },
    modelChain,
  );

  const parsed = parseResponse(result.content);

  return {
    response: { content: result.content, model: result.model },
    parsed,
  };
}
