import type {
  ChatMessage,
  OpenAIChatResponse,
} from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

export interface MeetingSummarizeRequest {
  metadata: {
    title: string;
    date?: string;
    participants?: string[];
    aliases?: Record<string, string[]>;
    context?: string;
    [key: string]: unknown;
  };
  transcript: string;
  model?: string;
  fallbackModels?: string[];
}

export interface MeetingSummarizeParsed {
  title: string;
  date: string;
  participants: string[];
  tags: string[];
  lang: string;
  overview: string;
  sessions: {
    time: string;
    speaker: string;
    topic: string;
    summary: string;
    key_points: string[];
    quotes: string[];
  }[];
  discussions: {
    time: string;
    topic: string;
    participants: string[];
    summary: string;
    questions: string[];
  }[];
  conclusions: string[];
  references: string[];
}

const SYSTEM_PROMPT = `You are a specialist in analyzing meeting transcripts and generating structured summaries.
You receive meeting metadata and a timestamped transcript, and produce a structured JSON response.

CONTEXT: These are recordings of kung fu master meetings ("Encontros de Mestres" / "Programa de Mestrado") where senior practitioners discuss martial arts philosophy, teaching methodology, system principles, and lineage history. The discussions are in Brazilian Portuguese. The conductor is Si Fu Julio Camacho, who leads the group with questions, corrections, and philosophical provocations.

IMPORTANT RULES:
- Base ALL output strictly on the provided transcript. Do not invent, infer, or hallucinate information not present in the input
- Output ONLY valid JSON, no markdown fences, no commentary
- All text fields must be in the same language as the transcript (usually Portuguese)
- Tags must be lowercase ASCII kebab-case (no accents), in order of relevance
- SPEAKER IDENTIFICATION: Use speech patterns, names mentioned, and context clues. When metadata includes an "aliases" map, treat all aliases as the SAME person — use the canonical name (the key) in all output. Example: if aliases has {"Thiago Silva": ["Chi Yau Si Moy", "Moy Chi Yau Si"]}, always output "Thiago Silva", never the alias
- When a speaker cannot be identified, use "Participante não identificado"
- Preserve the original terminology in Portuguese (e.g., "Ving Tsun", "Si Fu", "Moy Yat", "Kung Fu", "Siu Nim Tau")
- Quotes must be verbatim or very close paraphrases from the transcript, with timestamps
- Sessions represent distinct monologues or presentations by a single speaker
- Discussions represent exchanges, Q&A, or dialogues between multiple participants
- Pay attention to the DYNAMICS: who asks questions, who answers, who provokes, who corrects. The meeting format typically has short presentations (~3 min) followed by questions from other participants

OUTPUT SCHEMA:
{
  "title": "string — descriptive meeting title",
  "date": "string — meeting date (from metadata or transcript context)",
  "participants": ["string[] — full names or titles of identified participants"],
  "tags": ["string[] — 10-15 tags in kebab-case, in order of relevance"],
  "lang": "string — 'pt' or 'en' (detected from transcript)",
  "overview": "string — 3-5 paragraph markdown summary covering the main themes discussed across the entire meeting",
  "sessions": [
    {
      "time": "HH:MM:SS — start timestamp",
      "speaker": "string — name or identifier of the main speaker",
      "topic": "string — brief title of what this session covers (5-15 words)",
      "summary": "string — 2-4 paragraph detailed summary of the presentation/talk",
      "key_points": ["string[] — 3-8 main ideas or arguments presented"],
      "quotes": ["string[] — 2-5 notable verbatim quotes with [HH:MM:SS] timestamps"]
    }
  ],
  "discussions": [
    {
      "time": "HH:MM:SS — start timestamp",
      "topic": "string — what the discussion is about",
      "participants": ["string[] — who participated in this exchange"],
      "summary": "string — 1-3 paragraph summary of the exchange",
      "questions": ["string[] — key questions raised, with attribution if possible"]
    }
  ],
  "conclusions": ["string[] — key takeaways, decisions, or agreements reached"],
  "references": ["string[] — books, articles, people, concepts, or traditions mentioned"]
}`;

function buildUserPrompt(req: MeetingSummarizeRequest): string {
  const parts: string[] = [];

  parts.push("## Meeting Metadata");
  parts.push(`Title: ${req.metadata.title}`);
  if (req.metadata.date) parts.push(`Date: ${req.metadata.date}`);
  if (req.metadata.participants?.length) {
    parts.push(`Known participants: ${req.metadata.participants.join(", ")}`);
  }
  if (req.metadata.context) parts.push(`Context: ${req.metadata.context}`);

  if (req.metadata.aliases && Object.keys(req.metadata.aliases).length > 0) {
    parts.push("");
    parts.push("## Name Aliases (same person, use canonical name)");
    for (const [canonical, alts] of Object.entries(req.metadata.aliases)) {
      parts.push(`- ${canonical} = ${alts.join(", ")}`);
    }
  }

  parts.push("");
  parts.push("## Transcript (with timestamps)");
  parts.push(req.transcript);

  return parts.join("\n");
}

function parseResponse(content: string): MeetingSummarizeParsed {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  const required = ["title", "overview", "lang"] as const;
  for (const field of required) {
    if (!parsed[field] || typeof parsed[field] !== "string") {
      throw new Error(`Missing or invalid required field: ${field}`);
    }
  }

  return {
    title: parsed.title,
    date: parsed.date || "",
    participants: Array.isArray(parsed.participants) ? parsed.participants : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    lang: parsed.lang,
    overview: parsed.overview,
    sessions: Array.isArray(parsed.sessions)
      ? parsed.sessions.map((s: Record<string, unknown>) => ({
          time: String(s.time || "00:00:00"),
          speaker: String(s.speaker || ""),
          topic: String(s.topic || ""),
          summary: String(s.summary || ""),
          key_points: Array.isArray(s.key_points) ? s.key_points.map(String) : [],
          quotes: Array.isArray(s.quotes) ? s.quotes.map(String) : [],
        }))
      : [],
    discussions: Array.isArray(parsed.discussions)
      ? parsed.discussions.map((d: Record<string, unknown>) => ({
          time: String(d.time || "00:00:00"),
          topic: String(d.topic || ""),
          participants: Array.isArray(d.participants) ? d.participants.map(String) : [],
          summary: String(d.summary || ""),
          questions: Array.isArray(d.questions) ? d.questions.map(String) : [],
        }))
      : [],
    conclusions: Array.isArray(parsed.conclusions) ? parsed.conclusions.map(String) : [],
    references: Array.isArray(parsed.references) ? parsed.references.map(String) : [],
  };
}

export async function handleMeetingSummarize(
  req: MeetingSummarizeRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<{ response: OpenAIChatResponse; parsed: MeetingSummarizeParsed }> {
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

