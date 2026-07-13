/**
 * quote-note.ts — Scholion verified-quote composer (LLM only)
 *
 * Researches authorship on the web and composes the CONTENT of one Scholion
 * quote note as STRUCTURED JSON. It does NOT build the markdown / frontmatter —
 * that (the "how to publish" knowledge) belongs to the caller (Toscanini),
 * which serialises these fields deterministically. This keeps vox-intelligence
 * strictly an AI gateway.
 *
 * The model returns a single JSON object; the server validates it and does ONE
 * repair round-trip on malformed output before failing.
 */

import type { ChatMessage } from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

export interface QuoteNoteRequest {
  // The raw citation / paraphrase (becomes the title).
  quote: string;
  // Who the user believes said it (improves the authorship search).
  presumedAuthor?: string;
  // Optional source/context; if it names a work, that work is THE source.
  context?: string;
  model?: string;
  fallbackModels?: string[];
}

export interface QuoteSource {
  title: string;
  author?: string;
  year?: number;
  publisher?: string;
  url?: string;
  kind: string;
}

export interface QuoteNoteResult {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  has_commentary: boolean;
  sources: QuoteSource[];
  body: string;
  // verified=false when no primary source pins the attribution.
  authorship: { verified: boolean; notes: string };
  // Deterministic lexical hits in the body (PT-EU, banned vocab). Non-fatal.
  lexicalWarnings: string[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Same source-or-silence-validated chain the etymology-note preset settled on.
const PRESET_MODELS = ["openrouter/openai/gpt-5.4", "openrouter/openai/gpt-5.2"];

const SYSTEM_PROMPT = `Você compõe o CONTEÚDO de UMA nota de citação verificada para o Scholion, em PORTUGUÊS BRASILEIRO, a partir de uma FRASE, um AUTOR PRESUMIDO e um CONTEXTO DE PESQUISA de autoria. Você NÃO formata markdown nem YAML — devolve apenas um objeto JSON com os campos. A citação é o title; o body traz APENAS o contexto de autoria (quem disse, onde, quando).

REGRAS INEGOCIÁVEIS (valem para body e summary):
- Source-or-silence: NUNCA invente atribuição, obra, data ou fonte. Só afirme o que o CONTEXTO DE PESQUISA ou o CONTEXTO FORNECIDO sustentam.
- FONTE FORNECIDA PELO SOLICITANTE: se o CONTEXTO FORNECIDO nomeia uma obra de onde a citação foi extraída, essa obra É a fonte — inclua-a em sources e atribua a passagem a ela. A autoria está estabelecida pela proveniência informada: authorship.verified = true. Só use verified = false quando NÃO houver fonte fornecida E a pesquisa não fixar a autoria.
- COM FONTE FORNECIDA, o body é CURTO (1–2 frases) e APENAS situa a citação: obra, autor, capítulo/contexto. PROIBIDO pôr a fonte em dúvida ou comentar "pesquisa de circulação", "comentário secundário", "não fixou testemunho", autenticidade da redação ou proveniência da tradução. Se a pesquisa trouxer dúvida, IGNORE.
- WHITELIST do body: só pode conter autor, obra, ano e editora (SOMENTE se ancorados na pesquisa/contexto) e o capítulo/contexto da passagem. PROIBIDO mencionar edição, reedição, "2ª edição", "novo prefácio", reimpressão, tiragem, formato, volume ou ISBN (isso vai SÓ em sources, nunca como "esta passagem é da Nª edição"). E NUNCA afirme que o CONTEXTO FORNECIDO disse algo que ele não disse. O body termina ao situar a citação — sem frase de arremate.
- SITUAR, NÃO REAFIRMAR: NÃO reexponha o conteúdo factual da própria citação (fatos, atribuições, datas dentro dela são do AUTOR CITADO e já estão no title). Se mencionar, atribua explicitamente ("Segundo X", "Na passagem, o autor observa que..."), nunca como asserção própria genérica.
- Atribuição errônea: se a frase circula atribuída a X mas o autor real é Y, o body documenta onde circula como "X disse", o autor real Y com fonte, e o mecanismo da migração se identificável. tags incluem o autor real E o suposto.
- PT-BR estrito, NUNCA PT-EU (use você/está/trem/tela/concreto; nunca tu fazes/estás/comboio/betão/ecrã/facto/reacção/acção/telemóvel).
- Voz analítica e seca. NÃO termine com aforismo de fechamento. Travessão: no máximo 1 por parágrafo. Evite negativas indiretas.
- VOCABULÁRIO BANIDO: essencialmente, notavelmente, é importante notar, vale ressaltar, cabe destacar, nesse sentido, nesse contexto, em última análise, pode-se argumentar que, de certa forma, em muitos aspectos, ademais, outrossim, não obstante, destarte, indubitavelmente, inegavelmente, fascinante, surpreendente, intrigante, magistral, impressionante, extraordinário, genial, brilhante, comovente, tocante, deslumbrante, visionário. Nem "em suma/em resumo/em síntese/concluindo/portanto/enfim" abrindo parágrafo.

CAMPOS DO JSON:
- slug: string kebab-case, lowercase, sem acentos, ~50 chars, derivado da citação.
- title: a citação completa, sem o nome do autor, sem aspas literais em volta.
- summary: ~150–200 chars situando a citação (quem disse, onde/quando, controvérsia de atribuição se houver).
- tags: array de 2–4 strings kebab-case; a tag do autor é OBRIGATÓRIA.
- has_commentary: boolean (false para excerto/contexto factual; true só se houver análise original).
- sources: array; cada item { title (obrigatório), author?, year? (número), publisher?, url?, kind }. kind ∈ {book, article, wiki, podcast, video, paper, poem, repo, film, other}. NÃO fabricar URLs.
- body: prosa PT-BR que situa a citação (ver regras acima). NÃO repita a citação aqui.
- authorship: { verified: boolean, notes: string (motivo curto quando verified=false, senão "") }.

SAÍDA (CRÍTICO):
- Responda APENAS com o objeto JSON válido. Sem texto antes/depois, sem cercas de código, sem markdown.`;

function buildUserPrompt(req: QuoteNoteRequest, searchContext: string): string {
  const parts: string[] = [
    "===== FRASE (vira o title; NÃO repetir no body) =====",
    req.quote,
    "",
    `===== AUTOR PRESUMIDO ===== ${req.presumedAuthor || "(não informado)"}`,
  ];
  if (req.context && req.context.trim()) {
    parts.push("", "===== CONTEXTO FORNECIDO PELO SOLICITANTE =====", req.context.trim());
  }
  parts.push(
    "",
    "===== CONTEXTO DE PESQUISA DE AUTORIA (base factual — source-or-silence) =====",
    searchContext || "(nenhum resultado — se não conhecer fonte primária, authorship.verified=false)",
  );
  return parts.join("\n");
}

// Perplexity web search via OpenRouter — same helper pattern as holographic.ts.
async function webSearch(query: string, apiKey: string): Promise<string> {
  console.log(`[quote-note] web_search: "${query.slice(0, 120)}..."`);
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
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "(no results)";
}

function buildSearchQuery(req: QuoteNoteRequest): string {
  if (req.context && req.context.trim()) {
    return (
      "Provide only verifiable BIBLIOGRAPHIC details (original title, author, year, " +
      "publisher) for the work described here: " +
      `"${req.context}". Author: ${req.presumedAuthor || "unknown"}. ` +
      "Return concise facts with sources/URLs. Do NOT discuss misattribution or whether " +
      "the wording is authentic — the source is already established by the requester."
    );
  }
  const presumed = req.presumedAuthor ? ` It is often attributed to ${req.presumedAuthor}.` : "";
  return (
    `Who originally said or wrote the quote: "${req.quote}"?${presumed} ` +
    "Consult Quote Investigator (quoteinvestigator.com) and Wikiquote. " +
    "Report: the earliest exact wording; the real author with the work, year and context; " +
    "any well-known misattributions and how the misattribution spread. " +
    "If no primary source pins the attribution, say so explicitly. Cite the sources (with URLs)."
  );
}

// ---------- Deterministic lexical guard (subset of tests/style/test_lexical.py) ----------

const PT_EU = /(?<![\wÀ-ÿ])(facto|factos|reacção|reacções|acção|acções|comboio|autocarro|telemóvel|rapariga|raparigas|estás|tu fazes|tu vais|tu és|ecrã|betão)(?![\wÀ-ÿ])/i;
const BANNED_VOCAB = /(?<![\wÀ-ÿ])(essencialmente|notavelmente|é importante notar|vale ressaltar|cabe destacar|nesse sentido|em última análise|pode-se argumentar que|de certa forma|em muitos aspectos|ademais|outrossim|não obstante|destarte|indubitavelmente|inegavelmente|fascinante|surpreendente|intrigante|magistral|impressionante|extraordinário|genial|brilhante|comovente|deslumbrante|visionário)(?![\wÀ-ÿ])/i;

function lexicalCheck(body: string): string[] {
  const hits: string[] = [];
  const eu = body.match(PT_EU);
  if (eu) hits.push(`PT-EU: "${eu[0]}" (use PT-BR)`);
  const banned = body.match(BANNED_VOCAB);
  if (banned) hits.push(`vocabulário banido: "${banned[0]}"`);
  return hits;
}

// ---------- Parse + validate the JSON contract ----------

function normalizeSlug(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

type ParsedFields = Omit<QuoteNoteResult, "lexicalWarnings" | "model" | "usage">;

function parseFields(raw: string): ParsedFields {
  let text = raw.trim();
  // Strip code fences if the model wrapped the JSON.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Fallback: extract the outermost JSON object.
  if (!text.startsWith("{")) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON inválido: ${e instanceof Error ? e.message : String(e)}`);
  }

  const errs: string[] = [];
  const slug = normalizeSlug(obj.slug as string);
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  const tags = Array.isArray(obj.tags) ? (obj.tags as unknown[]).map(String).filter(Boolean) : [];
  const has_commentary = obj.has_commentary === true;
  const rawSources = Array.isArray(obj.sources) ? (obj.sources as Record<string, unknown>[]) : [];
  const auth = (obj.authorship ?? {}) as Record<string, unknown>;

  if (!slug) errs.push("slug ausente/vazio");
  if (!title) errs.push("title ausente");
  if (!summary) errs.push("summary ausente");
  if (!body) errs.push("body ausente");
  if (tags.length === 0) errs.push("tags vazias (ao menos a tag do autor)");
  if (rawSources.length === 0) errs.push("sources vazio");
  if (typeof auth.verified !== "boolean") errs.push("authorship.verified ausente");

  const sources: QuoteSource[] = rawSources
    .map((s) => {
      const src: QuoteSource = {
        title: typeof s.title === "string" ? s.title.trim() : "",
        kind: typeof s.kind === "string" && s.kind.trim() ? s.kind.trim() : "other",
      };
      if (typeof s.author === "string" && s.author.trim()) src.author = s.author.trim();
      if (typeof s.publisher === "string" && s.publisher.trim()) src.publisher = s.publisher.trim();
      if (typeof s.url === "string" && s.url.trim()) src.url = s.url.trim();
      const yr = typeof s.year === "number" ? s.year : parseInt(String(s.year ?? ""), 10);
      if (!Number.isNaN(yr) && yr > 0) src.year = yr;
      return src;
    })
    .filter((s) => s.title);

  if (sources.length === 0) errs.push("nenhuma source com title");
  if (errs.length) throw new Error("validação falhou: " + errs.join("; "));

  return {
    slug,
    title,
    summary,
    tags,
    has_commentary,
    sources,
    body,
    authorship: {
      verified: auth.verified === true,
      notes: typeof auth.notes === "string" ? auth.notes.trim() : "",
    },
  };
}

export async function handleQuoteNote(
  req: QuoteNoteRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<QuoteNoteResult> {
  // 1. Research authorship (best-effort).
  let searchContext = "";
  if (config.openrouterApiKey) {
    try {
      searchContext = await webSearch(buildSearchQuery(req), config.openrouterApiKey);
    } catch (err) {
      console.error("[quote-note] web search failed, continuing without it:", err);
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req, searchContext) },
  ];

  const modelChain = resolveModelChain(req.model, req.fallbackModels, PRESET_MODELS, config.defaultModels);

  const result = await factory.completeWithFallback(
    { model: "", messages, maxTokens: config.maxOutputTokens, temperature: 0.2 },
    modelChain,
  );

  let fields: ParsedFields;
  let model = result.model;
  let usage = result.usage;

  try {
    fields = parseFields(result.content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[quote-note] parse falhou (${reason}); head: ${JSON.stringify(result.content.slice(0, 300))}`);
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content:
          `Sua resposta anterior não é um JSON válido no contrato (${reason}). ` +
          "Responda novamente APENAS com o objeto JSON, com todos os campos exigidos, " +
          "sem texto fora do JSON e sem cercas de código.",
      },
    ];
    const retry = await factory.completeWithFallback(
      { model: "", messages: repairMessages, maxTokens: config.maxOutputTokens, temperature: 0 },
      modelChain,
    );
    fields = parseFields(retry.content);
    model = retry.model;
    usage =
      retry.usage && result.usage
        ? {
            promptTokens: result.usage.promptTokens + retry.usage.promptTokens,
            completionTokens: result.usage.completionTokens + retry.usage.completionTokens,
          }
        : retry.usage ?? result.usage;
  }

  return {
    ...fields,
    lexicalWarnings: lexicalCheck(fields.body),
    model,
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        }
      : undefined,
  };
}
