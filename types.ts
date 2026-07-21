// Core interfaces for vox-intelligence AI gateway

export interface AIProvider {
  readonly name: string;
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

// Multimodal content parts (OpenAI Vision format)
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  reasoning?: { effort: "none" | "low" | "medium" | "high" };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

// Helpers for multimodal content

export function getTextContent(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p): p is TextContentPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function hasImages(msg: ChatMessage): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some((p) => p.type === "image");
}

export function requestHasImages(req: ChatCompletionRequest): boolean {
  return req.messages.some(hasImages);
}

/**
 * Resolve model chain with 3-tier priority: user > preset > config global.
 *
 * - If user provides model/fallbackModels in the API request, use those exclusively.
 * - Else if the preset defines its own defaults, use those.
 * - Else fall back to config.defaultModels (global).
 */
export function resolveModelChain(
  userModel: string | undefined,
  userFallbacks: string[] | undefined,
  presetDefaults: string[] | undefined,
  configDefaults: string[],
): string[] {
  if (userModel || userFallbacks?.length) {
    const chain: string[] = [];
    if (userModel) chain.push(userModel);
    if (userFallbacks) chain.push(...userFallbacks);
    return chain;
  }
  if (presetDefaults?.length) return [...presetDefaults];
  return [...configDefaults];
}

export interface ChatCompletionResponse {
  content: string;
  finishReason: "stop" | "length" | "error";
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ModelConfig {
  provider: "openrouter" | "ollama" | "openai" | "anthropic";
  model: string;
  isReasoning: boolean;
  timeoutMs: number;
}

// OpenAI-compatible API types (external-facing)

export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning?: { effort: "none" | "low" | "medium" | "high" };
  "x-fallback-models"?: string[];
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length";
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Preset types

export interface PodcastEpisodeRequest {
  metadata: {
    title: string;
    podcast: string;
    published?: string;
    duration?: string;
    source?: string;
    [key: string]: unknown;
  };
  transcript: string;
  bookmarks?: string[];
  model?: string;
  fallbackModels?: string[];
}

export interface RecommendationItem {
  title: string;
  description: string;
}

export interface PodcastEpisodeParsed {
  title: string;
  description: string;
  aliases: string[];
  participants: string[];
  tags: string[];
  lang: string;
  summary: string;
  timeline: { time: string; topic: string; summary: string }[];
  recommendations: Record<string, RecommendationItem[]>;
  annotations?: { time: string; title: string; description: string }[];
}

export interface PodcastAnnotateRequest {
  transcript: string;
  bookmarks: { time: string; note?: string }[];
  model?: string;
  fallbackModels?: string[];
}

export interface PodcastAnnotation {
  time: string;
  title: string;
  key_quotes: string[];
  description: string;
}

// Vision preset types

export interface ExtractBookmarksRequest {
  images: string[]; // base64-encoded images
  model?: string;
  fallbackModels?: string[];
}

export interface ExtractBookmarksResult {
  bookmarks: number;
  timestamps: string[];
}
