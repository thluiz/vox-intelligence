/**
 * holographic-dialog.ts — Scholion dialog preset for vox-intelligence
 *
 * Generates a structured scholion (title + markdown content) from:
 * - The full episode JSON
 * - A user message (text or voice-transcribed)
 * - Optional timestamp context
 * - Optional existing dialog to refine
 *
 * Uses a tool_use loop: GPT-5.2 decides when to call web_search (Perplexity),
 * then synthesises a final {title, content} JSON response.
 */

import type { ChatMessage } from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory, parseModelString } from "../../providers/provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HolographicDialogRequest {
  episode: Record<string, unknown>;
  message: string;
  timestamp?: string;
  existing_dialog?: { title: string; content: string };
  model?: string;
  fallbackModels?: string[];
  useWebSearch?: boolean;
}

export interface HolographicDialogResult {
  title: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(lang: string): string {
  const isPort = lang === "pt";

  return isPort
    ? `Você é um assistente de análise de episódios de podcast. O utilizador está a ler/ouvir um episódio e quer aprofundar ideias, cruzar referências ou registar reflexões como *scholia* — notas de margem no espírito da tradição grega/medieval.

Você tem acesso a uma ferramenta de pesquisa web (web_search). Use-a quando precisar de:
- Informações biográficas sobre pessoas mencionadas
- Contexto histórico ou filosófico
- Detalhes sobre livros, obras ou conceitos referenciados
- Qualquer facto externo ao episódio

Quando não há contexto de pesquisa, baseie-se exclusivamente no episódio e no conhecimento próprio.

No final, produza SEMPRE um JSON válido com este formato exato:
{"title": "Título conciso em 5-10 palavras", "content": "Texto completo em markdown..."}

Regras:
- Output APENAS JSON válido na resposta final, sem markdown fences
- O texto deve estar na mesma língua do episódio
- O content pode incluir markdown (bold, italic, listas, links)
- Seja substancial mas focado (2-6 parágrafos)`
    : `You are a podcast episode analysis assistant. The user is reading/listening to an episode and wants to deepen ideas, cross-reference, or record reflections as *scholia* — margin notes in the Greek/medieval scholiast tradition.

You have access to a web search tool (web_search). Use it when you need:
- Biographical information about mentioned people
- Historical or philosophical context
- Details about books, works, or concepts referenced
- Any factual knowledge external to the episode

When no search context is provided, base your response solely on the episode and your own knowledge.

At the end, ALWAYS produce valid JSON in this exact format:
{"title": "Concise title in 5-10 words", "content": "Full text in markdown..."}

Rules:
- Output ONLY valid JSON in the final response, no markdown fences
- Content should be in the same language as the episode
- Content may include markdown (bold, italic, lists, links)
- Be substantial but focused (2-6 paragraphs)`;
}

function buildUserPrompt(req: HolographicDialogRequest, searchContext = ""): string {
  const episode = req.episode;
  const fm = (episode.frontmatter as Record<string, unknown>) || {};
  const lang = (fm.lang as string) || "pt";
  const isPort = lang === "pt";

  const parts: string[] = [];

  // Episode context
  const title = fm.title || episode.title || "";
  const podcast = fm.podcast || (episode.metadata as Record<string, unknown>)?.podcast || "";
  const participants = fm.participants || episode.participants || [];
  const summary = episode.summary || "";

  parts.push(isPort ? "## Episódio" : "## Episode");
  if (title) parts.push(`**Título**: ${title}`);
  if (podcast) parts.push(`**Podcast**: ${podcast}`);
  if (Array.isArray(participants) && participants.length > 0) {
    parts.push(`**Participantes**: ${participants.join(", ")}`);
  }

  // Timeline context around timestamp
  const timeline = (episode.timeline as { ts?: string; time?: string; description?: string; topic?: string; summary?: string }[]) || [];
  if (req.timestamp && timeline.length > 0) {
    const tsSeconds = parseTimestamp(req.timestamp);
    // Find closest timeline entries within ±10 minutes
    const nearby = timeline
      .filter((t) => {
        const s = parseTimestamp(t.ts || t.time || "");
        return Math.abs(s - tsSeconds) <= 600;
      })
      .slice(0, 3);

    if (nearby.length > 0) {
      parts.push("");
      parts.push(isPort ? `## Contexto no timestamp ${req.timestamp}` : `## Context at ${req.timestamp}`);
      for (const t of nearby) {
        const ts = t.ts || t.time || "";
        const topic = t.topic || "";
        const desc = t.description || t.summary || "";
        parts.push(`- **${ts}**: ${topic ? `**${topic}** — ` : ""}${desc}`);
      }
    }
  }

  // Summary (first 1000 chars)
  if (summary) {
    parts.push("");
    parts.push(isPort ? "## Resumo do Episódio" : "## Episode Summary");
    parts.push(String(summary).substring(0, 1000) + (String(summary).length > 1000 ? "..." : ""));
  }

  // Existing dialog to refine
  if (req.existing_dialog) {
    parts.push("");
    parts.push(isPort ? "## Scholion Existente (para refinar/aprofundar)" : "## Existing Scholion (to refine/deepen)");
    parts.push(`**${req.existing_dialog.title}**`);
    parts.push(req.existing_dialog.content);
    parts.push("");
    parts.push(
      isPort
        ? "Refine e aprofunde o scholion acima com base na mensagem do utilizador abaixo."
        : "Refine and deepen the scholion above based on the user message below."
    );
  }

  // User message
  parts.push("");
  parts.push(isPort ? "## Mensagem do Utilizador" : "## User Message");
  if (req.timestamp) {
    parts.push(`*(${isPort ? "Timestamp" : "Timestamp"}: ${req.timestamp})*`);
  }
  parts.push(req.message);

  // Web search results (if present)
  if (searchContext) {
    parts.push("");
    parts.push(isPort ? "## Contexto de Pesquisa Web" : "## Web Search Context");
    parts.push(searchContext);
  }

  return parts.join("\n");
}

function parseTimestamp(ts: string): number {
  if (!ts) return 0;
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}


// ---------------------------------------------------------------------------
// Perplexity web search (explicit, user-triggered)
// ---------------------------------------------------------------------------

async function webSearch(query: string, apiKey: string): Promise<string> {
  console.log(`[holographic-dialog] web_search: "${query}"`);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://vox.thluiz.com",
      "X-Title": "vox-intelligence-scholion",
    },
    body: JSON.stringify({
      model: "perplexity/sonar-pro",
      messages: [{ role: "user", content: query }],
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Perplexity search failed ${res.status}: ${text}`);
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "(no results)";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleHolographicDialog(
  req: HolographicDialogRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<HolographicDialogResult> {
  const episode = req.episode;
  const fm = (episode.frontmatter as Record<string, unknown>) || {};
  const lang = (fm.lang as string) || "pt";

  const presetDefaults = ["openrouter/openai/gpt-4.1", "openrouter/anthropic/claude-opus-4-5"];
  const modelChain = resolveModelChain(req.model, req.fallbackModels, presetDefaults, config.defaultModels);
  const primaryModel = modelChain[0];
  const parsed = parseModelString(primaryModel);

  const provider = factory.getProvider(parsed.provider);
  if (!provider) {
    throw new Error(`Provider "${parsed.provider}" not configured`);
  }

  // Optional web search (explicit, user-triggered)
  let searchContext = "";
  if (req.useWebSearch && config.openrouterApiKey) {
    console.log(`[holographic-dialog] Web search requested`);
    try {
      searchContext = await webSearch(req.message, config.openrouterApiKey);
    } catch (err) {
      console.error("[holographic-dialog] Web search failed, continuing without it:", err);
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(lang) },
    { role: "user", content: buildUserPrompt(req, searchContext) },
  ];

  // Direct call via ProviderFactory
  console.log(`[holographic-dialog] Calling ${primaryModel}${req.useWebSearch ? " (with web search context)" : ""}`);

  const result = await factory.completeWithFallback(
    {
      model: primaryModel,
      messages,
      maxTokens: config.maxOutputTokens,
      temperature: 0.4,
    },
    modelChain,
  );

  return parseDialogResponse(result.content);
}

function parseDialogResponse(content: string): HolographicDialogResult {
  let cleaned = content.trim();
  // Strip markdown fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  // Try JSON parse
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.title || !parsed.content) {
      throw new Error("Missing title or content in response");
    }
    return {
      title: String(parsed.title).trim(),
      content: String(parsed.content).trim(),
    };
  } catch {
    // Fallback: extract JSON object from text
    const match = cleaned.match(/\{[\s\S]*"title"[\s\S]*"content"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        title: String(parsed.title || "").trim(),
        content: String(parsed.content || "").trim(),
      };
    }
    throw new Error(`Failed to parse holographic-dialog response as JSON: ${cleaned.substring(0, 200)}`);
  }
}
