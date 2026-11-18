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
import { presetChain, globalChain } from "../../routing";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";
import { openRouterTraceFields } from "../../observability";

export interface QuoteNoteRequest {
  // The raw citation / paraphrase (becomes the title).
  quote: string;
  // Who the user believes said it (improves the authorship search).
  presumedAuthor?: string;
  // Optional source/context; if it names a work, that work is THE source.
  context?: string;
  // Optional explicit source URL (Amazon/Kindle link) — activates book mode.
  sourceUrl?: string;
  // Optional explicit "this came from a book" flag — activates book mode.
  fromBook?: boolean;
  model?: string;
  fallbackModels?: string[];
}

// Amazon / Kindle / short-link — strong signal that the quote came from a book.
const BOOK_URL = /https?:\/\/(?:[a-z0-9-]+\.)?(?:amazon\.[a-z.]+|amzn\.[a-z.]+|amz\.onl|a\.co|kindle\.[a-z.]+|read\.amazon\.[a-z.]+)\/\S+/i;

// A post on a social network: the post itself is a dated, attributable source.
const SOCIAL_URL = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:x\.com|twitter\.com|bsky\.app|threads\.net|threads\.com|mastodon\.[a-z.]+|linkedin\.com|instagram\.com|facebook\.com)\//i;

const ANY_URL = /https?:\/\/[^\s"'<>()\[\]{}]+/gi;

// Book mode only on an explicit signal: the fromBook flag or a book link.
// A free-text context is NOT a book signal (until 1.6.0 any context switched
// book mode on, and a tweet context made the model invent the "book" the
// tweet came from — Berkopec → McBreen's Software Craftsmanship).
export function detectBook(req: QuoteNoteRequest): { bookMode: boolean; bookUrl: string | null } {
  const bookUrl =
    (req.sourceUrl && req.sourceUrl.match(BOOK_URL)?.[0]) ||
    req.quote.match(BOOK_URL)?.[0] ||
    (req.context && req.context.match(BOOK_URL)?.[0]) ||
    null;
  const bookMode = Boolean(req.fromBook || bookUrl);
  return { bookMode, bookUrl };
}

export function isSocialUrl(url: string | undefined | null): boolean {
  return Boolean(url && SOCIAL_URL.test(url.trim()));
}

// Comparable form of a URL: no scheme, no www./mobile., twitter.com ≡ x.com,
// no trailing slash or trailing punctuation, no query/fragment for social posts.
export function urlKey(url: string): string {
  let u = url.trim().replace(/[.,;:!?)\]}>"']+$/, "");
  u = u.replace(/^https?:\/\//i, "").replace(/^(?:www\.|mobile\.)/i, "");
  const slash = u.indexOf("/");
  let host = (slash === -1 ? u : u.slice(0, slash)).toLowerCase();
  let rest = slash === -1 ? "" : u.slice(slash);
  if (host === "twitter.com") host = "x.com";
  if (host === "x.com") rest = rest.replace(/[?#].*$/, "");
  rest = rest.replace(/\/+$/, "");
  return host + rest;
}

export function extractUrls(...texts: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const t of texts) if (t) for (const m of t.matchAll(ANY_URL)) out.push(m[0]);
  return out;
}

// "Tweet de @handle" from an x.com/twitter.com status URL.
export function socialSourceTitle(url: string): string {
  const m = urlKey(url).match(/^x\.com\/([^/]+)\/status\//);
  if (m) return `Tweet de @${m[1]}`;
  const host = urlKey(url).split("/")[0];
  return `Post em ${host}`;
}

// The title is the citation only — never a URL. Strip any book link the Kindle
// share appended to the quote text.
function cleanQuote(quote: string): string {
  return quote.replace(BOOK_URL, "").replace(/\s+/g, " ").trim();
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
  // What enforceProvenance changed (origin URL added, unconsulted URL dropped,
  // work without a consulted source → verified=false). Non-fatal.
  provenanceWarnings: string[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Same source-or-silence-validated chain the etymology-note preset settled on.
const PRESET_MODELS = ["openrouter/openai/gpt-5.4", "openrouter/openai/gpt-5.2"];

const SYSTEM_PROMPT = `Você compõe o CONTEÚDO de UMA nota de citação verificada para o Scholion, em PORTUGUÊS BRASILEIRO, a partir de uma FRASE, um AUTOR PRESUMIDO e um CONTEXTO DE PESQUISA de autoria. Você NÃO formata markdown nem YAML — devolve apenas um objeto JSON com os campos. A citação é o title; o body traz APENAS o contexto de autoria (quem disse, onde, quando).

REGRAS INEGOCIÁVEIS (valem para body e summary):
- Source-or-silence: NUNCA invente atribuição, obra, data ou fonte. Só afirme o que o CONTEXTO DE PESQUISA ou o CONTEXTO FORNECIDO sustentam.
- URL DE ORIGEM: se houver URL DE ORIGEM INFORMADA, ela entra SEMPRE em sources, com essa url exata. Ela é de onde a citação veio — nunca a omita nem a troque por outra.
- POST DE REDE SOCIAL (tweet, post): se o CONTEXTO FORNECIDO diz que o post é do próprio autor presumido, o post É a fonte primária: source { title: "Tweet de @handle, <data>", author: <autor>, url: <url do post>, kind: "web" }, authorship.verified = true, e o body diz que o autor publicou a frase nesse post (com a data). Se o post é de OUTRA conta citando o autor presumido, ele é só onde a frase circulou: entra em sources, o body diz que a conta X atribuiu a frase ao autor, e a autoria depende da pesquisa (abaixo).
- OBRA SÓ COM FONTE CONSULTADA: só atribua a frase a um livro, artigo, ensaio ou palestra se essa obra aparecer, ligada a ESSA frase, no CONTEXTO DE PESQUISA (com URL) ou no CONTEXTO FORNECIDO. Toda source além da URL de origem precisa ter url que aparece no CONTEXTO DE PESQUISA. Obra que você "conhece" mas a pesquisa não trouxe NÃO entra — nem em sources, nem no body, nem no summary. Sem fonte assim e sem post do próprio autor: authorship.verified = false, e o body diz apenas onde a frase foi encontrada.
- FONTE FORNECIDA PELO SOLICITANTE: se o CONTEXTO FORNECIDO afirma que a citação foi extraída de uma obra e a nomeia, essa obra É a fonte — inclua-a em sources e atribua a passagem a ela, com authorship.verified = true. Mencionar onde a frase foi vista (um post, um site) NÃO é nomear a obra de origem.
- O SOLICITANTE NÃO APARECE NA NOTA: nunca escreva "solicitante", "situado pelo solicitante", "segundo o solicitante", "informado pelo solicitante" nem atribua a quem pediu a nota qualquer afirmação. O que o CONTEXTO FORNECIDO diz entra como fato sobre a frase (onde e quando apareceu), sem dizer quem informou.
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
- sources: array; cada item { title (obrigatório), author?, year? (número), publisher?, url?, kind }. kind ∈ {book, article, wiki, podcast, video, paper, poem, repo, film, web, other} (post de rede social e agregador de citações = web). NÃO fabricar URLs: só URLs que estão na URL DE ORIGEM, no CONTEXTO FORNECIDO ou no CONTEXTO DE PESQUISA.
- body: prosa PT-BR que situa a citação (ver regras acima). NÃO repita a citação aqui.
- authorship: { verified: boolean, notes: string (motivo curto quando verified=false, senão "") }.

SAÍDA (CRÍTICO):
- Responda APENAS com o objeto JSON válido. Sem texto antes/depois, sem cercas de código, sem markdown.`;

export function buildUserPrompt(
  req: QuoteNoteRequest,
  searchContext: string,
  book: { bookMode: boolean; bookUrl: string | null },
): string {
  const parts: string[] = [
    "===== FRASE (vira o title; NÃO repetir no body; o title é SÓ a citação, sem URL) =====",
    cleanQuote(req.quote),
    "",
    `===== AUTOR PRESUMIDO ===== ${req.presumedAuthor || "(não informado)"}`,
  ];
  const origin = req.sourceUrl?.trim();
  if (origin) {
    parts.push(
      "",
      "===== URL DE ORIGEM INFORMADA (entra SEMPRE em sources, url exata) =====",
      origin + (isSocialUrl(origin) ? "  (post de rede social — ver regra POST DE REDE SOCIAL)" : ""),
    );
  }
  if (req.context && req.context.trim()) {
    parts.push("", "===== CONTEXTO FORNECIDO (fatos sobre a frase; NÃO citar quem informou) =====", req.context.trim());
  }
  if (book.bookMode) {
    parts.push(
      "",
      "===== MODO LIVRO (ATIVO) =====",
      "A citação vem de um LIVRO — a fonte é DEFINITIVA; authorship.verified = true; NÃO a questione." +
        (book.bookUrl ? ` Inclua esta URL numa source com kind:book: ${book.bookUrl}` : "") +
        " O body é ESTRITAMENTE MÍNIMO: UMA frase que só situa (autor + obra). PROIBIDO pesquisar dúvida, comentar edição/prefácio/circulação, ou acrescentar qualquer coisa além de situar.",
    );
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
      ...openRouterTraceFields("web-search"),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Perplexity search failed ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    citations?: unknown[];
    choices?: {
      message?: {
        content?: string;
        annotations?: { type?: string; url_citation?: { url?: string; title?: string } }[];
      };
    }[];
  };
  const message = data.choices?.[0]?.message;
  const content = message?.content || "(no results)";
  // Perplexity puts the consulted URLs beside the text (citations /
  // url_citation annotations), with only [n] markers inline. Append them, so
  // the model can cite them and enforceProvenance sees them as consulted.
  const cited: string[] = [];
  for (const c of data.citations ?? []) if (typeof c === "string") cited.push(c);
  for (const a of message?.annotations ?? []) {
    const u = a.url_citation?.url;
    if (u) cited.push(a.url_citation?.title ? `${u} (${a.url_citation.title})` : u);
  }
  const unique = [...new Set(cited)];
  return unique.length
    ? `${content}\n\nFONTES CONSULTADAS PELA PESQUISA:\n${unique.map((u, i) => `[${i + 1}] ${u}`).join("\n")}`
    : content;
}

export function buildSearchQuery(req: QuoteNoteRequest): string {
  const { bookMode } = detectBook(req);
  const context = req.context?.trim();
  if (bookMode && context) {
    return (
      "Provide only verifiable BIBLIOGRAPHIC details (original title, author, year, " +
      "publisher) for the work described here: " +
      `"${context}". Author: ${req.presumedAuthor || "unknown"}. ` +
      "Return concise facts with sources/URLs. Do NOT discuss misattribution or whether " +
      "the wording is authentic — the source is already established by the requester."
    );
  }
  const presumed = req.presumedAuthor ? ` It is often attributed to ${req.presumedAuthor}.` : "";
  const seen = req.sourceUrl?.trim()
    ? ` It was found at ${req.sourceUrl.trim()}${context ? ` (${context.slice(0, 400)})` : ""}.`
    : context
      ? ` Context: ${context.slice(0, 400)}.`
      : "";
  return (
    `Who originally said or wrote the quote: "${cleanQuote(req.quote)}"?${presumed}${seen} ` +
    "Consult Quote Investigator (quoteinvestigator.com), Wikiquote, Goodreads and the author's own " +
    "books, essays and posts. Report: the earliest exact wording you can document; the work, year " +
    "and context ONLY if a source you cite ties this wording to it; any well-known misattributions. " +
    "If the earliest appearance is a social media post, say so. If no source ties the quote to a " +
    "book or article, say so explicitly — do not guess a work. Cite every source with its URL."
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

type ParsedFields = Omit<QuoteNoteResult, "lexicalWarnings" | "provenanceWarnings" | "model" | "usage">;

const MENTIONS_REQUESTER = /solicitante/i;

export function parseFields(raw: string): ParsedFields {
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
  if (MENTIONS_REQUESTER.test(body) || MENTIONS_REQUESTER.test(summary))
    errs.push("body/summary mencionam o solicitante (proibido: a nota não atribui nada a quem a pediu)");

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

// ---------- Deterministic provenance guard ----------

const WORK_KINDS = new Set(["book", "article", "paper", "poem", "film", "podcast", "video"]);

/**
 * Enforces the provenance rules the prompt states, without trusting the model:
 *  - the informed sourceUrl is always in sources (prepended if the model left it out);
 *  - a source URL that appears nowhere in the input or the search context was not
 *    consulted: the URL is dropped;
 *  - a work (book, article…) with no consulted URL is an attribution without a
 *    verifiable source: authorship.verified becomes false (Toscanini saves it as a
 *    draft). In book mode the requester's book is exempt — it IS the source.
 * Returns the fixed fields and the list of what was changed.
 */
export function enforceProvenance(
  fields: ParsedFields,
  req: QuoteNoteRequest,
  searchContext: string,
  book: { bookMode: boolean; bookUrl: string | null },
): { fields: ParsedFields; warnings: string[] } {
  const warnings: string[] = [];
  const origin = req.sourceUrl?.trim() || null;
  const consulted = new Set(
    extractUrls(origin, req.context, req.quote, searchContext).map(urlKey),
  );

  let sources = fields.sources.map((s) => {
    if (s.url && !consulted.has(urlKey(s.url))) {
      warnings.push(`url não consultada removida de "${s.title}": ${s.url}`);
      const { url: _drop, ...rest } = s;
      return rest as QuoteSource;
    }
    return s;
  });

  if (origin && !sources.some((s) => s.url && urlKey(s.url) === urlKey(origin))) {
    const social = isSocialUrl(origin);
    const isBook = Boolean(book.bookUrl && urlKey(book.bookUrl) === urlKey(origin));
    sources = [
      {
        title: social ? socialSourceTitle(origin) : isBook ? "Livro (link informado)" : "Fonte informada",
        url: origin,
        kind: isBook ? "book" : "web",
      },
      ...sources,
    ];
    warnings.push(`URL de origem ausente em sources; incluída: ${origin}`);
  }

  const unsourcedWorks = book.bookMode
    ? []
    : sources.filter((s) => WORK_KINDS.has(s.kind) && !s.url);

  let authorship = fields.authorship;
  if (unsourcedWorks.length > 0) {
    const names = unsourcedWorks.map((s) => `"${s.title}"`).join(", ");
    warnings.push(`obra sem fonte consultada: ${names}`);
    if (authorship.verified) {
      authorship = {
        verified: false,
        notes: [authorship.notes, `Atribuição a ${names} sem fonte consultada (URL); revisar.`]
          .filter(Boolean)
          .join(" "),
      };
    }
  }

  return { fields: { ...fields, sources, authorship }, warnings };
}

export async function handleQuoteNote(
  req: QuoteNoteRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<QuoteNoteResult> {
  const book = detectBook(req);

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
    { role: "user", content: buildUserPrompt(req, searchContext, book) },
  ];

  const modelChain = resolveModelChain(req.model, req.fallbackModels, await presetChain("scholion/quote-note", PRESET_MODELS), await globalChain(config.defaultModels));

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

  const enforced = enforceProvenance(fields, req, searchContext, book);
  if (enforced.warnings.length) console.log(`[quote-note] provenance: ${enforced.warnings.join(" | ")}`);
  fields = enforced.fields;

  return {
    ...fields,
    lexicalWarnings: lexicalCheck(fields.body),
    provenanceWarnings: enforced.warnings,
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
