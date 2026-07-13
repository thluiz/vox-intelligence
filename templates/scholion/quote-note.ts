/**
 * quote-note.ts — Scholion verified-quote note preset
 *
 * Synthesises ONE Scholion quote note (PT-BR markdown, frontmatter + body) from
 * a raw quote + a presumed author. Mirrors the `add-scholion-quote` skill: it
 * researches authorship on the web (Perplexity), then composes a note whose
 * title IS the citation and whose body carries only the authorship context —
 * under strict source-or-silence (never invent an attribution).
 *
 * Contract with the model (line-based, like etymology-note.ts):
 *   line 1: `SLUG: <slug>`
 *   line 2: `AUTHORSHIP: verified` | `AUTHORSHIP: unverified — <motivo>`
 *   line 3: blank
 *   line 4+: the full note, starting at `---` (frontmatter)
 *
 * The server parses/validates that contract and does ONE repair round-trip on
 * malformed output before failing (mirrors etymology-note.ts / ghost-audit.ts).
 *
 * This preset only SYNTHESISES. Writing to disk + git commit is the caller's
 * job (Toscanini). The ghost-audit structural gate is run separately by the
 * caller against the returned note.
 */

import type { ChatMessage } from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

export interface QuoteNoteRequest {
  // The raw citation / paraphrase the user supplied.
  quote: string;
  // Who the user believes said it (optional — improves the authorship search).
  presumedAuthor?: string;
  // Optional extra context the caller wants folded into the research.
  context?: string;
  // Frontmatter date, ISO with offset — computed by the CALLER with the real
  // local clock (never invented server-side).
  date: string;
  model?: string;
  fallbackModels?: string[];
}

export interface QuoteNoteResult {
  slug: string;
  note: string;
  // verified=false when no primary source pins the attribution — the caller
  // uses this to gate publication (source-or-silence).
  authorship: { verified: boolean; notes: string };
  // Deterministic lexical hits that survived the repair round-trip (PT-EU,
  // banned vocab). Non-fatal — the caller's ghost-audit is the hard gate.
  lexicalWarnings: string[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Same source-or-silence-validated chain the etymology-note preset settled on
// (deepseek hallucinates attributions in this task). Confirmar com o autor.
const PRESET_MODELS = ["openrouter/openai/gpt-5.4", "openrouter/openai/gpt-5.2"];

const SYSTEM_PROMPT = `Você redige UMA nota de citação verificada para o Scholion, em PORTUGUÊS BRASILEIRO, a partir de uma FRASE, um AUTOR PRESUMIDO e um CONTEXTO DE PESQUISA de autoria. A citação vira o TÍTULO; o corpo traz APENAS o contexto de autoria (quem disse, onde, quando).

REGRAS INEGOCIÁVEIS:
- Source-or-silence: NUNCA invente atribuição, obra, data ou fonte. Só afirme o que o CONTEXTO DE PESQUISA ou o CONTEXTO FORNECIDO sustentam.
- FONTE FORNECIDA PELO SOLICITANTE: se o CONTEXTO FORNECIDO nomeia uma obra (livro, ensaio, discurso) de onde a citação foi extraída, essa obra É a fonte — registre-a em sources e atribua a passagem a ela. Nesse caso a autoria está estabelecida pela própria proveniência informada: marque AUTHORSHIP: verified. Só marque AUTHORSHIP: unverified quando NÃO houver fonte fornecida E a pesquisa não fixar a autoria.
- COM FONTE FORNECIDA, o corpo é CURTO (1–2 frases) e APENAS situa a citação: obra, autor, capítulo/contexto. É TERMINANTEMENTE PROIBIDO pôr a fonte em dúvida ou escrever qualquer comentário sobre "pesquisa de circulação", "circulação", "comentário secundário moderno", "não fixou testemunho", autenticidade da redação, ou a proveniência da tradução. O solicitante já asseverou a fonte; a nota não litiga isso. Se a pesquisa web trouxer dúvida sobre a redação, IGNORE — não a escreva. Não descreva "efeitos" vagos da passagem ("síntese interpretativa", "horizonte", "no espírito de") — situe concretamente ou omita.
- SITUAR, NÃO REAFIRMAR: o corpo SITUA a citação na sua fonte (obra, autor, capítulo, contexto da passagem) e para aí. NÃO reexponha nem reafirme o conteúdo factual da própria citação — as afirmações dentro da citação (fatos históricos, atribuições, datas) são responsabilidade do AUTOR CITADO, já constam no título, e NÃO devem ser reescritas na sua voz como se fossem fatos independentes. Quando precisar mencionar o conteúdo, atribua-o explicitamente ao autor/obra ("Segundo X", "Na passagem, o autor observa que..."), nunca como asserção própria e genérica ("a tradição clássica", "sabe-se que").
- Atribuição errônea: se a frase circula atribuída a X mas o autor real é Y, o TÍTULO é a frase, o corpo documenta (a) onde circula como "X disse", (b) o autor real Y com fonte, (c) o mecanismo da migração, se identificável. Tags incluem o autor real E o suposto.
- A citação NÃO vai no corpo (ela é o título, renderizada com CSS de citação). Sem blockquote. Sem "Fonte:" no fim do corpo — fontes ficam só no frontmatter.
- PT-BR estrito, NUNCA PT-EU: use "você/está/trem/tela/concreto", nunca "tu fazes/estás/comboio/betão/ecrã/facto/reacção/acção/telemóvel".
- Voz analítica e seca, não panegírica nem condenatória. O corpo é factual: contexto na obra/discurso/carta, formulação original (em itálico se idioma estrangeiro) + tradução PT-BR, e recepção se atestada.
- NÃO terminar com frase sintetizadora nem aforismo de fechamento ("e assim X nos lembra que...", "no fim, é a ironia que vence"). Termine no fato, no contexto ou na recepção.
- Distinguir narrador de autor quando aplicável (Brás Cubas ≠ Machado, Álvaro de Campos ≠ Pessoa).
- Travessão: no máximo 1 por parágrafo; prefira vírgula, parênteses ou dois-pontos. Evite negativas indiretas ("não é incomum que", "não deixa de ser", "não raro") — reescreva em positivo.
- VOCABULÁRIO BANIDO (não use): essencialmente, notavelmente, é importante notar, vale ressaltar, cabe destacar, nesse sentido, nesse contexto, em última análise, pode-se argumentar que, de certa forma, em muitos aspectos, ademais, outrossim, não obstante, destarte, indubitavelmente, inegavelmente, fascinante, surpreendente, intrigante, magistral, impressionante, extraordinário, genial, brilhante, comovente, tocante, deslumbrante, visionário. Nem "em suma/em resumo/em síntese/concluindo/portanto/enfim" abrindo parágrafo.

FRONTMATTER (YAML, exatamente estes campos, nesta ordem):
- title: "<a citação completa, sem o nome do autor. Use as aspas duplas do YAML, mas NÃO acrescente aspas literais em volta da citação dentro delas>"
- date: '<date fornecido pelo usuário, exatamente, entre aspas simples>'
- category: quote
- summary: '<~150-200 chars entre aspas SIMPLES: quem disse, onde/quando, e se há controvérsia de atribuição>'
- tags: ["<autor-real-kebab>", "<tema-kebab>"]   # tag do autor é OBRIGATÓRIA; para misatribuição, incluir suposto e real
- has_commentary: false
- sources: lista de fontes efetivamente sustentadas pela pesquisa, cada uma com title, e quando houver author/year/publisher/url, e kind (book|article|wiki|podcast|video|paper|poem|repo|film|other). NÃO fabricar URLs.

SAÍDA (CRÍTICO — obedeça):
- NÃO explique, NÃO comente antes nem depois, NÃO use cercas de código.
- 1ª linha, exatamente: SLUG: <slug em lowercase, sem acentos, hífens no lugar de espaços/pontuação, ~50 chars>
- 2ª linha, exatamente: AUTHORSHIP: verified   (se há fonte primária)   OU   AUTHORSHIP: unverified — <motivo curto>
- 3ª linha: em branco.
- Da 4ª linha em diante: a nota completa, começando em "---" (frontmatter). Nada além da nota.`;

function buildUserPrompt(req: QuoteNoteRequest, searchContext: string): string {
  const parts: string[] = [
    "===== FRASE (vira o título; NÃO repetir no corpo) =====",
    req.quote,
    "",
    `===== AUTOR PRESUMIDO ===== ${req.presumedAuthor || "(não informado)"}`,
    `===== DATE do frontmatter ===== '${req.date}'`,
  ];
  if (req.context && req.context.trim()) {
    parts.push("", "===== CONTEXTO FORNECIDO PELO SOLICITANTE =====", req.context.trim());
  }
  parts.push(
    "",
    "===== CONTEXTO DE PESQUISA DE AUTORIA (base factual — source-or-silence) =====",
    searchContext || "(nenhum resultado de pesquisa disponível — se não conhecer fonte primária, marque unverified)",
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
  // Fonte fornecida pelo solicitante: buscar só dados bibliográficos, não
  // disputa de autoria (não queremos que o modelo escreva dúvida na nota).
  if (req.context && req.context.trim()) {
    return (
      "Provide only verifiable BIBLIOGRAPHIC details (original title, author, year, " +
      "publisher, chapter/edition) for the work described here: " +
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
const BANNED_VOCAB = /(?<![\wÀ-ÿ])(essencialmente|notavelmente|é importante notar|vale ressaltar|cabe destacar|nesse sentido|nesse contexto|em última análise|pode-se argumentar que|de certa forma|em muitos aspectos|ademais|outrossim|não obstante|destarte|indubitavelmente|inegavelmente|fascinante|surpreendente|intrigante|magistral|impressionante|extraordinário|genial|brilhante|comovente|deslumbrante|visionário)(?![\wÀ-ÿ])/i;

// Strip frontmatter so we only lint the prose body.
function noteBody(note: string): string {
  const m = note.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : note;
}

function lexicalCheck(note: string): string[] {
  const body = noteBody(note);
  const hits: string[] = [];
  const eu = body.match(PT_EU);
  if (eu) hits.push(`PT-EU: "${eu[0]}" (use PT-BR)`);
  const banned = body.match(BANNED_VOCAB);
  if (banned) hits.push(`vocabulário banido: "${banned[0]}"`);
  return hits;
}

// ---------- Parse + validate the SLUG/AUTHORSHIP/note contract ----------

interface ParsedQuote {
  slug: string;
  note: string;
  authorship: { verified: boolean; notes: string };
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseQuoteResponse(rawIn: string): ParsedQuote {
  const raw = rawIn.trim();

  const slugMatch = raw.match(/^SLUG:\s*(.+)$/im);
  if (!slugMatch) throw new Error("saída sem linha 'SLUG: ...'");
  const slug = normalizeSlug(slugMatch[1].trim());
  if (!slug) throw new Error("slug vazio após normalização");

  const authMatch = raw.match(/^AUTHORSHIP:\s*(verified|unverified)\s*(?:—|-{1,2})?\s*(.*)$/im);
  if (!authMatch) throw new Error("saída sem linha 'AUTHORSHIP: verified|unverified'");
  const authorship = {
    verified: authMatch[1].toLowerCase() === "verified",
    notes: (authMatch[2] || "").trim(),
  };

  const fmStart = raw.indexOf("\n---");
  const firstDash = raw.trimStart().startsWith("---") ? raw.indexOf("---") : fmStart >= 0 ? fmStart + 1 : -1;
  if (firstDash < 0) throw new Error("saída sem frontmatter começando em '---'");

  let note = raw.slice(firstDash).trim();
  note = note.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "").trim() + "\n";

  // O modelo às vezes envolve a citação em aspas literais dentro do title
  // (`title: "\"...\""`). Remove-as deterministicamente.
  note = note.replace(/^title:\s*"\\"(.*)\\""\s*$/m, 'title: "$1"');

  // Convenção Scholion: summary entre aspas SIMPLES (YAML). Requote quando o
  // modelo usa aspas duplas.
  note = note.replace(/^summary:\s*"(.*)"\s*$/m, (_all, v: string) =>
    `summary: '${v.replace(/\\"/g, '"').replace(/'/g, "''")}'`,
  );

  const errs: string[] = [];
  if (!note.startsWith("---")) errs.push("não começa com frontmatter");
  if (!/^category:\s*quote\s*$/m.test(note)) errs.push("frontmatter sem 'category: quote'");
  if (!/^title:\s*"/m.test(note)) errs.push("sem title entre aspas duplas");
  if (!/^date:\s*'/m.test(note)) errs.push("sem date entre aspas simples");
  if (!/^summary:\s*'/m.test(note)) errs.push("summary sem aspas simples");
  if (!/^tags:\s*\[.+\]/m.test(note)) errs.push("sem tags (com ao menos a tag do autor)");
  if (!/^has_commentary:\s*(true|false)\s*$/m.test(note)) errs.push("sem has_commentary");
  if (!/^sources:\s*$/m.test(note)) errs.push("sem bloco sources");
  if (errs.length) throw new Error("validação falhou: " + errs.join("; "));

  return { slug, note, authorship };
}

export async function handleQuoteNote(
  req: QuoteNoteRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<QuoteNoteResult> {
  // 1. Research authorship (best-effort — compose even if search is unavailable).
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

  let parsed: ParsedQuote;
  let model = result.model;
  let usage = result.usage;

  // Combine contract parse + lexical guard into one validation, so a single
  // repair round-trip fixes both classes of problem.
  function validate(content: string): { parsed: ParsedQuote; lexical: string[] } {
    const p = parseQuoteResponse(content);
    const lexical = lexicalCheck(p.note);
    if (lexical.length) throw new Error("guarda lexical: " + lexical.join("; "));
    return { parsed: p, lexical };
  }

  let lexicalWarnings: string[] = [];
  try {
    const ok = validate(result.content);
    parsed = ok.parsed;
    lexicalWarnings = ok.lexical;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(
      `[quote-note] parse/lint falhou (${reason}); head: ${JSON.stringify(result.content.slice(0, 300))}`,
    );
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content:
          `Sua resposta anterior violou o contrato de saída (${reason}). ` +
          "Responda novamente APENAS com: linha 1 'SLUG: ...', linha 2 'AUTHORSHIP: verified|unverified — ...', " +
          "linha 3 em branco, e a nota completa a partir do '---'. Sem cercas de código, sem comentários, " +
          "e sem os termos PT-EU / do vocabulário banido apontados.",
      },
    ];
    const retry = await factory.completeWithFallback(
      { model: "", messages: repairMessages, maxTokens: config.maxOutputTokens, temperature: 0 },
      modelChain,
    );
    // On the repair pass, accept the contract even if lexical hits survive —
    // surface them as warnings; the caller's ghost-audit is the hard gate.
    parsed = parseQuoteResponse(retry.content);
    lexicalWarnings = lexicalCheck(parsed.note);
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
    slug: parsed.slug,
    note: parsed.note,
    authorship: parsed.authorship,
    lexicalWarnings,
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
