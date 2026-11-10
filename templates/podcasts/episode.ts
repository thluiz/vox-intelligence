import type {
  ChatMessage,
  ChatCompletionResponse,
  PodcastEpisodeRequest,
  PodcastEpisodeParsed,
  OpenAIChatResponse,
} from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

// Summary chain. The first model is the cheap one; its output is only trusted
// after the verification pass below. The others are the quality fallbacks.
const PRESET_MODELS = [
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/anthropic/claude-sonnet-5.5",
  "openrouter/openai/gpt-5.2",
];

// Fact-checks the summary against the transcript and repairs what it finds.
// Must be a different model family from the first summary model: a model
// re-reading its own summary repeats its own misreadings.
const VERIFY_MODELS = ["openrouter/anthropic/claude-haiku-5.5"];

// A non-final model gets this long before the chain moves on, so a slow first
// attempt cannot eat the caller's whole HTTP timeout.
const ATTEMPT_BUDGET_MS = 420_000;

// Issue severities that get repaired. "low" is cosmetic and left alone.
const REPAIR_SEVERITIES = new Set(["high", "medium"]);

const SYSTEM_PROMPT = `You are a specialist in analyzing podcast episodes and generating structured metadata.
You receive episode metadata and a transcript, and produce a structured JSON response.

IMPORTANT RULES:
- Base ALL output strictly on the provided metadata and transcript. Do not invent, infer, or hallucinate information that is not present in the input
- The one exception is the title field: if the title cannot be clearly determined from the metadata, derive a clean, descriptive title from the transcript content (do NOT output "undefined" or leave it blank)
- Output ONLY valid JSON, no markdown fences, no commentary
- All text fields must be in the same language as the transcript (detect automatically)
- Tags must be lowercase ASCII kebab-case (no accents - e.g. "tapajos" not "tapajós"), in order of relevance, up to 10
- Participants: extract only the names of hosts and guests who actively speak or participate in the conversation. Do NOT include people who are merely mentioned, discussed, quoted, or referenced as third parties
- Timeline: key moments with timestamps from the transcript. For each entry, include a brief summary (2-4 sentences) describing the discussion at that point - similar to a bookmark annotation
- Recommendations: group by category (e.g. books, articles, tools, people, movies, places, podcasts, music - use whatever categories are relevant to the episode content). Only include categories that have entries. For each item, provide a title and a brief description of what was said about it in the episode
- Summary: 3-5 paragraphs covering the main topics discussed
- Description: 1-2 sentences for metadata/SEO (og:description)
- Annotations: if bookmarks are provided, generate an annotation for each bookmark timestamp. Read the transcript context around +-60 seconds of the marked timestamp, understand what is being discussed, and produce a title and brief summary. When multiple bookmarks are within 30 seconds of each other and cover the same topic, merge them into a single annotation: use the earliest timestamp, but read context from 60s before the first bookmark to 60s after the last bookmark in the cluster, as this typically indicates a longer topic with multiple key points. If no bookmarks section is present, omit the annotations field entirely

GROUNDING RULES (these override everything above when in conflict):
- The transcript is machine-generated and has NO speaker labels. It is your only source of facts
- Proper names: write every name of a person, place, work or organization exactly as it is spelled in the transcript, even when you believe the transcript misspelled it. Never "correct" a name from your own knowledge
- No outside knowledge: never add a year, date, job title, office, nationality, author, cast member, plot description or any other fact that the transcript does not state, even if you are sure it is true
- Speaker attribution: attribute a statement, opinion or recommendation to a named person ONLY when the transcript makes the speaker unambiguous at that point (the person is addressed by name right before speaking, or identifies themselves). Otherwise use a neutral subject ("the hosts", "one of the participants", in the transcript language)
- Jokes, irony, analogies and hypotheticals are not facts. Conversational podcasts are full of them ("their own X", "the X of Y"). Do not report them as literal events or literal relationships. When you cannot tell whether a passage is literal, leave it out
- Do not add qualifiers, quantities or outcomes the transcript does not state (e.g. "narrow", "historic", "record")
- Timeline timestamps must be copied exactly from the transcript line where the topic starts. Do not round them
- Titles of works: copy the title as spoken in the transcript; do not translate it or replace it with an official title
- When in doubt, omit. A shorter output with only supported facts is better than a richer one with a single unsupported fact

OUTPUT SCHEMA:
{
  "title": "string - clean episode title without podcast name or episode number prefix. If not present in metadata, derive from transcript",
  "description": "string - 1-2 sentence summary for metadata",
  "aliases": ["string[] - alternative titles or common abbreviations found in the transcript or metadata, NOT the episode number"],
  "participants": ["string[] - full names of host(s) and guest(s)"],
  "tags": ["string[] - up to 10 most relevant tags in kebab-case, in order of relevance"],
  "lang": "string - 'pt' or 'en' (detected from transcript)",
  "summary": "string - 3-5 paragraph markdown summary",
  "timeline": [{"time": "HH:MM:SS", "topic": "string - brief title (5-10 words)", "summary": "string - 2-4 sentence description of what is discussed at this point"}],
  "recommendations": {"<category>": [{"title": "string - item name", "description": "string - 1-2 sentences about what was said about this item in the episode"}]},
  "annotations": [{"time": "HH:MM:SS", "title": "string - concise title (5-10 words)", "description": "string - 1-3 sentence description"}]
}`;

const VERIFY_SYSTEM_PROMPT = `You verify a podcast episode summary against the episode's machine transcript (which has no speaker labels). The transcript and the metadata are the ONLY source of truth.

Go through the summary field by field (description, participants, summary, every timeline entry, every recommendation) and find every claim that the transcript does not support:
- a fact, number, date, title, role, profession or relationship the transcript does not state (even if true in the real world)
- something the transcript says differently, including jokes, irony, analogies or hypotheticals reported as literal facts, and descriptions attached to the wrong person
- a statement or recommendation attributed to a named person when the transcript does not make clear who is speaking, or attributes it to someone else
- a host or guest missing from, or wrongly included in, the participants (check how the hosts introduce themselves and each other)
- a proper name spelled differently from the transcript
- a timeline time that is more than 90 seconds away from where the topic is discussed

Before answering, re-read the transcript passages behind each named person and each specific claim. Report only problems you can demonstrate with a transcript quote (or "not in transcript"). Do not report style issues or omissions.

Output ONLY valid JSON, no markdown fences:
{"issues": [{"where": "description | participants | summary | timeline[<time>] | recommendations[<title>]", "claim": "the unsupported text, quoted from the summary", "problem": "short explanation", "evidence": "transcript quote or 'not in transcript'", "severity": "high|medium|low"}]}`;

const REPAIR_SYSTEM_PROMPT = `You edit a podcast episode summary (JSON) to remove verified problems. You receive the summary and a list of issues found by a fact-checker, each with the offending claim, an explanation and the transcript evidence.

Rules:
- Fix ONLY the listed issues. Every other sentence, field, timeline entry and recommendation must stay byte-for-byte identical
- Preferred fix: delete the unsupported claim, or reword it neutrally (for example replace a named speaker with a neutral subject in the summary's language, or drop an added detail)
- You may state a correction only when the issue's evidence explicitly contains it (for example a participant named in the quoted transcript passage). Never add anything from your own knowledge
- For a timeline entry whose time is wrong for a claim: remove that claim from the entry; if nothing substantive remains, remove the entry. Never invent or change a timestamp
- Keep the JSON structure and key names exactly as received

Output ONLY the corrected JSON, no markdown fences, no commentary.`;

// The fields the verifier checks and the repair may change. Everything else
// (title, aliases, tags, lang, annotations) passes through untouched.
const VERIFIED_FIELDS = ["description", "participants", "summary", "timeline", "recommendations"] as const;

interface VerifyIssue {
  where: string;
  claim: string;
  problem: string;
  evidence: string;
  severity: string;
}

export interface EpisodeVerification {
  /** clean: nothing to repair. repaired: issues fixed. unverified: the pass could not run. skipped: caller opted out. */
  status: "clean" | "repaired" | "unverified" | "skipped";
  issues: number;
  repaired: number;
  model?: string;
  reason?: string;
}

type Usage = ChatCompletionResponse["usage"];

function addUsage(a: Usage, b: Usage): Usage {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

function metadataLines(req: PodcastEpisodeRequest): string[] {
  const parts: string[] = [];
  parts.push("## Episode Metadata");
  parts.push(`Title: ${req.metadata.title}`);
  parts.push(`Podcast: ${req.metadata.podcast}`);
  if (req.metadata.published) parts.push(`Published: ${req.metadata.published}`);
  if (req.metadata.duration) parts.push(`Duration: ${req.metadata.duration}`);
  if (req.metadata.source) parts.push(`Source: ${req.metadata.source}`);
  return parts;
}

function buildUserPrompt(req: PodcastEpisodeRequest): string {
  const parts = metadataLines(req);

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

function verifiedView(parsed: PodcastEpisodeParsed): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of VERIFIED_FIELDS) view[field] = parsed[field];
  return view;
}

function buildVerifyPrompt(req: PodcastEpisodeRequest, parsed: PodcastEpisodeParsed): string {
  return [
    ...metadataLines(req),
    "",
    "## Transcript",
    req.transcript,
    "",
    "## Summary to verify",
    JSON.stringify(verifiedView(parsed), null, 1),
  ].join("\n");
}

function stripFences(content: string): string {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return cleaned;
}

function parseTimeline(raw: unknown): PodcastEpisodeParsed["timeline"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t))
    .map((t) => ({
      time: String(t.time || "00:00:00"),
      topic: String(t.topic || ""),
      summary: String(t.summary || ""),
    }));
}

function parseRecommendations(raw: unknown): PodcastEpisodeParsed["recommendations"] {
  const recommendations: PodcastEpisodeParsed["recommendations"] = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return recommendations;
  for (const [cat, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) continue;
    recommendations[cat] = (items as Record<string, unknown>[])
      .filter((item) => !!item && typeof item === "object")
      .map((item) => ({
        title: String(item.title ?? ""),
        description: String(item.description ?? ""),
      }));
  }
  return recommendations;
}

function parseResponse(content: string): PodcastEpisodeParsed {
  const parsed = JSON.parse(stripFences(content));

  // Validate required fields
  const required = ["title", "description", "summary", "lang"] as const;
  for (const field of required) {
    if (!parsed[field] || typeof parsed[field] !== "string") {
      throw new Error(`Missing or invalid required field: ${field}`);
    }
  }

  return {
    title: parsed.title,
    description: parsed.description,
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
    participants: Array.isArray(parsed.participants) ? parsed.participants : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    lang: parsed.lang,
    summary: parsed.summary,
    timeline: parseTimeline(parsed.timeline),
    recommendations: parseRecommendations(parsed.recommendations),
    annotations: Array.isArray(parsed.annotations)
      ? parsed.annotations.map((a: Record<string, unknown>) => ({
          time: String(a.time || "00:00:00"),
          title: String(a.title || ""),
          description: String(a.description || ""),
        }))
      : undefined,
  };
}

function parseIssues(content: string): VerifyIssue[] {
  const obj = JSON.parse(stripFences(content));
  const raw = Array.isArray(obj) ? obj : obj.issues;
  if (!Array.isArray(raw)) throw new Error("verifier output has no issues array");
  return raw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      where: String(i.where ?? ""),
      claim: String(i.claim ?? ""),
      problem: String(i.problem ?? ""),
      evidence: String(i.evidence ?? ""),
      severity: String(i.severity ?? "medium").toLowerCase(),
    }));
}

/**
 * Applies the repaired fields on top of the original summary. Throws when the
 * repair did something it was told not to, so the caller can fall back.
 */
function mergeRepair(original: PodcastEpisodeParsed, content: string): PodcastEpisodeParsed {
  const fixed = JSON.parse(stripFences(content));
  if (!fixed || typeof fixed !== "object" || Array.isArray(fixed)) {
    throw new Error("repair output is not an object");
  }

  const description = typeof fixed.description === "string" ? fixed.description.trim() : "";
  const summary = typeof fixed.summary === "string" ? fixed.summary.trim() : "";
  if (!description || !summary) throw new Error("repair output lost description or summary");

  const timeline = parseTimeline(fixed.timeline);
  const knownTimes = new Set(original.timeline.map((t) => t.time));
  const invented = timeline.filter((t) => !knownTimes.has(t.time)).map((t) => t.time);
  if (invented.length) throw new Error(`repair changed timeline timestamps: ${invented.join(", ")}`);

  // A repair removes sentences; one that drops most of the text went wrong.
  if (summary.length < original.summary.length * 0.5) {
    throw new Error("repair removed more than half of the summary");
  }
  if (original.timeline.length > 0 && timeline.length < original.timeline.length * 0.5) {
    throw new Error("repair removed more than half of the timeline");
  }

  return {
    ...original,
    description,
    summary,
    participants: Array.isArray(fixed.participants) ? fixed.participants.map(String) : original.participants,
    timeline,
    recommendations: parseRecommendations(fixed.recommendations),
  };
}

interface Generated {
  parsed: PodcastEpisodeParsed;
  result: ChatCompletionResponse;
  usage: Usage;
  /** Index in the model chain of the model that produced `parsed`. */
  index: number;
}

/**
 * Walks the chain one model at a time from `start`. Unlike a plain fallback
 * call, an answer that is not valid JSON also moves on to the next model.
 */
async function generate(
  messages: ChatMessage[],
  modelChain: string[],
  start: number,
  factory: ProviderFactory,
  config: Config,
): Promise<Generated> {
  const errors: string[] = [];
  let usage: Usage;

  for (let index = start; index < modelChain.length; index++) {
    const model = modelChain[index];
    const isLast = index === modelChain.length - 1;
    try {
      const result = await factory.completeWithFallback(
        {
          model: "",
          messages,
          maxTokens: config.maxOutputTokens,
          temperature: 0.3,
          deadline: isLast ? undefined : Date.now() + ATTEMPT_BUDGET_MS,
        },
        [model],
      );
      usage = addUsage(usage, result.usage);
      const parsed = parseResponse(result.content);
      return { parsed, result, usage, index };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[podcast-episode] ${model}: unusable (${msg.slice(0, 300)})${isLast ? "" : ", trying next model"}`);
      errors.push(`${model}: ${msg}`);
    }
  }

  throw new Error(`All models failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

interface Verified {
  parsed: PodcastEpisodeParsed;
  verification: EpisodeVerification;
  usage: Usage;
}

/** Runs verification and, when needed, repair. Throws if either step cannot complete. */
async function verifyAndRepair(
  req: PodcastEpisodeRequest,
  parsed: PodcastEpisodeParsed,
  factory: ProviderFactory,
  config: Config,
): Promise<Verified> {
  const verify = await factory.completeWithFallback(
    {
      model: "",
      messages: [
        { role: "system", content: VERIFY_SYSTEM_PROMPT },
        { role: "user", content: buildVerifyPrompt(req, parsed) },
      ],
      maxTokens: config.maxOutputTokens,
      traceStep: "verify",
    },
    VERIFY_MODELS,
  );
  let usage: Usage = verify.usage;

  const issues = parseIssues(verify.content);
  const toRepair = issues.filter((i) => REPAIR_SEVERITIES.has(i.severity));
  for (const issue of toRepair) {
    console.log(`[podcast-episode] verify [${issue.severity}] ${issue.where}: ${issue.problem.slice(0, 200)}`);
  }

  if (toRepair.length === 0) {
    return {
      parsed,
      usage,
      verification: { status: "clean", issues: issues.length, repaired: 0, model: verify.model },
    };
  }

  const repair = await factory.completeWithFallback(
    {
      model: "",
      messages: [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `## Summary\n${JSON.stringify(verifiedView(parsed), null, 1)}\n\n` +
            `## Issues to fix\n${JSON.stringify(toRepair, null, 1)}`,
        },
      ],
      maxTokens: config.maxOutputTokens,
      traceStep: "repair",
    },
    VERIFY_MODELS,
  );
  usage = addUsage(usage, repair.usage);

  return {
    parsed: mergeRepair(parsed, repair.content),
    usage,
    verification: { status: "repaired", issues: issues.length, repaired: toRepair.length, model: verify.model },
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

  const modelChain = resolveModelChain(req.model, req.fallbackModels, PRESET_MODELS, config.defaultModels);

  let generated = await generate(messages, modelChain, 0, factory, config);
  let usage = generated.usage;
  let parsed = generated.parsed;
  let verification: EpisodeVerification;

  if (req.verify === false) {
    verification = { status: "skipped", issues: 0, repaired: 0 };
  } else {
    try {
      const verified = await verifyAndRepair(req, parsed, factory, config);
      parsed = verified.parsed;
      verification = verified.verification;
      usage = addUsage(usage, verified.usage);
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.log(`[podcast-episode] verification failed (${reason})`);
      verification = { status: "unverified", issues: 0, repaired: 0, reason };

      // An unverified answer from the first model is the risky case: redo the
      // summary with the stronger models behind it rather than ship it as is.
      if (generated.index === 0 && modelChain.length > 1) {
        try {
          console.log(`[podcast-episode] regenerating with ${modelChain[1]} instead of shipping an unverified summary`);
          const retry = await generate(messages, modelChain, 1, factory, config);
          usage = addUsage(usage, retry.usage);
          generated = retry;
          parsed = retry.parsed;
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.log(`[podcast-episode] regeneration failed (${msg.slice(0, 300)}); keeping the unverified summary`);
        }
      }
    }
  }

  console.log(
    `[podcast-episode] ${generated.result.model}: verification=${verification.status} ` +
      `issues=${verification.issues} repaired=${verification.repaired}`,
  );

  const result = generated.result;
  const id = `vi-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const response: OpenAIChatResponse = {
    id,
    object: "chat.completion",
    model: result.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(parsed) },
      finish_reason: result.finishReason === "length" ? "length" : "stop",
    }],
    usage: usage ? {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    } : undefined,
    "x-verification": verification,
  };

  return { response, parsed };
}
