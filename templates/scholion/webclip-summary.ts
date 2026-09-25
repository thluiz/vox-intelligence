/**
 * webclip-summary.ts — Scholion webclip note composer (LLM only)
 *
 * Composes the CONTENT of one Scholion `category: webclip` note (resumo +
 * fichamento, summary, tags, slug) from the raw text captured by
 * fetch-webclip.mjs. Mirrors quote-note.ts: returns structured JSON, does
 * NOT build frontmatter/YAML or the `sources` block — that (URL, domain,
 * archived-clipping link) is deterministic and stays with the caller
 * (add-scholion-webclip skill).
 *
 * Ghost-writer's voice rules (banned closers, dash-for-effect, mechanical
 * parallelism, source-or-silence, paraphrase-only) are baked into the
 * system prompt so the FIRST draft already complies — the skill's mandatory
 * `/presets/scholion/ghost-audit` gate still runs afterward as the
 * independent auditor (that gate stays strict by design, see
 * feedback_ghost_audit_gate_estrito), but should now need far fewer
 * fix-and-recheck round trips.
 *
 * Moving composition here (instead of the interactive agent reading the
 * full clipped text and drafting in its own context) is the same move as
 * the podcast suggest-annotations/annotate presets: keep the raw text off
 * the paid interactive context, pay for it once in a cheap server call.
 */

import type { ChatMessage } from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

export interface WebclipRelatedNote {
  slug: string;
  title: string;
  // Optional one-line hint of why it's related (from the author's search-first pick).
  hint?: string;
}

export interface WebclipSummaryRequest {
  // Raw captured text (verbatim, step 3 of the skill). Never edited by the caller.
  text: string;
  // Captured page title (may be cleaned up by the model if truncated/generic).
  title: string;
  url: string;
  domain: string;
  // Notes the author already approved linking to, from the skill's search-first step.
  // The model links to these ONLY when a point it's already making genuinely connects —
  // never forced, never a "see also" tack-on.
  relatedNotes?: WebclipRelatedNote[];
  model?: string;
  fallbackModels?: string[];
  // Optional wall-clock budget (ms) for the whole preset, fallbacks and the
  // JSON-repair retry included. Callers with a short HTTP timeout (e.g.
  // scholion-webclipper) send it so the upstream call dies with them.
  timeoutMs?: number;
}

export interface WebclipSummaryResult {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  // Detected language of the source text (e.g. "pt", "en") — informational.
  language: string;
  // "<resumo em prosa>\n\n## Fichamento\n\n- ..." ("## Reading notes" in an English note). No frontmatter, no "Fonte:".
  body: string;
  has_commentary: false;
  // Deterministic lexical hits (PT-EU, banned PT-BR vocab) when language is Portuguese. Non-fatal.
  lexicalWarnings: string[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Same chain the quote-note preset settled on: gpt-5.4 has been the reliable
// source-or-silence performer for Scholion prose composition, gpt-5.2 as fallback.
const PRESET_MODELS = ["openrouter/openai/gpt-5.4", "openrouter/openai/gpt-5.2"];

const SYSTEM_PROMPT = `Você compõe o CONTEÚDO de UMA nota "webclip" do Scholion a partir do TEXTO BRUTO de uma página capturada. Você NÃO formata frontmatter/YAML nem monta "sources" — devolve apenas um objeto JSON com os campos. NÃO É análise autoral: é fichamento, síntese do que a página diz.

REGRAS INEGOCIÁVEIS:
- Língua: resumo, fichamento, summary e tags seguem a LÍNGUA DO TEXTO BRUTO fornecido, nunca forçar PT-BR. Página em inglês → nota em inglês. Página em português → nota em PT-BR (nunca PT-EU: não usar "tu fazes/estás/comboio/autocarro/ecrã/betão/facto/reacção/acção/telemóvel").
- NUNCA misturar línguas: a nota inteira fica numa língua só. Numa página em inglês, o resumo, a heading, CADA item do fichamento, o summary e as tags ficam em inglês: nenhuma palavra de português na nota. Estas instruções estão em português, mas isso não muda a língua-alvo.
- Source-or-silence: cada ponto do fichamento e cada frase do resumo precisa vir do TEXTO BRUTO. NUNCA invente, complete ou infira além do que está escrito. Se um ponto não está claramente no texto, omita — não parafraseie de forma plausível para preencher.
- Fichamento PARAFRASEADO, nunca verbatim — trechos citáveis literais não pertencem aqui.
- Sem "Fonte:" no corpo — fontes vivem só no frontmatter, que você não escreve.
- Sem análise/comentário próprio além do que a página argumenta — has_commentary é sempre false aqui.

VOZ (aplicar mesmo em outra língua, adaptando ao idioma-alvo):
- PROIBIDO fecho aforístico: parágrafo ou fichamento terminando num mini-punch sintetizador, frase "esperta" que resume o que já foi dito.
- PROIBIDO ritmo em três batidas (frase curta. Reviravolta. Frase curta.) onde uma frase com conjunção bastaria.
- PROIBIDO negativa indireta ("não é X e sim Y") quando dá para afirmar direto.
- PROIBIDO travessão/hífen/dois-pontos como pausa dramática (setup→punch) em prosa corrente.
- PROIBIDO paralelismo mecânico: listas com termos genéricos vazios (proteger/guiar/ensinar) só para parecer estrutura.
- PROIBIDA voz genérica de IA: se, tirando o nome da página/autor, o texto poderia ter sido escrito por qualquer resumo automático, reescreva mais concreto.
- Se a língua-alvo for PT-BR, vocabulário banido: essencialmente, notavelmente, é importante notar, vale ressaltar, cabe destacar, nesse sentido, em última análise, pode-se argumentar que, de certa forma, ademais, outrossim, não obstante, destarte, indubitavelmente, inegavelmente, fascinante, surpreendente, intrigante, magistral, impressionante, extraordinário, genial, brilhante, comovente, deslumbrante, visionário. Nem "em suma/em resumo/concluindo/portanto" abrindo parágrafo.

CROSS-LINKS (só se NOTAS RELACIONADAS foi fornecido): use wikilink "[[slug|texto]]" apontando para uma nota relacionada SOMENTE quando um ponto que você já estava fazendo genuinamente conecta com ela. Nunca force, nunca acrescente frase só para caber o link, nunca cite uma nota relacionada que não tenha conexão real com o que o texto diz.

CAMPOS DO JSON:
- slug: kebab-case, lowercase, sem acentos, ~50 chars, derivado do título.
- title: o título da página, ajustado só se estiver truncado ou genérico demais.
- summary: ~150–200 chars na língua-alvo — o que a página argumenta, não uma descrição genérica ("artigo sobre...").
- tags: array de 2–4 strings kebab-case, na língua-alvo, incluindo tema(s) das NOTAS RELACIONADAS quando genuinamente aplicável.
- language: código curto da língua-alvo (ex. "pt", "en", "es").
- body: "<resumo em prosa, 1–2 parágrafos>\n\n## Fichamento\n\n- <ponto 1>\n- <ponto 2>\n...". A heading segue a língua-alvo: "## Fichamento" em português, "## Reading notes" em inglês, o equivalente direto em outra língua. Sempre numa linha própria, com linha em branco antes.

SAÍDA (CRÍTICO):
- Responda APENAS com o objeto JSON válido. Sem texto antes/depois, sem cercas de código, sem markdown fora do campo "body".`;

function buildUserPrompt(req: WebclipSummaryRequest): string {
  const parts: string[] = [
    `===== TÍTULO CAPTURADO ===== ${req.title}`,
    `===== URL ===== ${req.url}`,
    `===== DOMÍNIO ===== ${req.domain}`,
  ];
  if (req.relatedNotes && req.relatedNotes.length > 0) {
    parts.push(
      "",
      "===== NOTAS RELACIONADAS (aprovadas pelo autor; linkar só se genuinamente conectar) =====",
      ...req.relatedNotes.map(
        (n) => `- slug: ${n.slug} | title: ${n.title}${n.hint ? ` | hint: ${n.hint}` : ""}`,
      ),
    );
  }
  parts.push("", "===== TEXTO BRUTO CAPTURADO (verbatim; única base factual) =====", req.text);
  return parts.join("\n");
}

// ---------- Deterministic lexical guard (subset of tests/style/test_lexical.py) ----------

const PT_EU = /(?<![\wÀ-ÿ])(facto|factos|reacção|reacções|acção|acções|comboio|autocarro|telemóvel|rapariga|raparigas|estás|tu fazes|tu vais|tu és|ecrã|betão)(?![\wÀ-ÿ])/i;
const BANNED_VOCAB = /(?<![\wÀ-ÿ])(essencialmente|notavelmente|é importante notar|vale ressaltar|cabe destacar|nesse sentido|em última análise|pode-se argumentar que|de certa forma|em muitos aspectos|ademais|outrossim|não obstante|destarte|indubitavelmente|inegavelmente|fascinante|surpreendente|intrigante|magistral|impressionante|extraordinário|genial|brilhante|comovente|deslumbrante|visionário)(?![\wÀ-ÿ])/i;

function lexicalCheck(body: string, language: string): string[] {
  if (!language.toLowerCase().startsWith("pt")) return [];
  const hits: string[] = [];
  const eu = body.match(PT_EU);
  if (eu) hits.push(`PT-EU: "${eu[0]}" (use PT-BR)`);
  const banned = body.match(BANNED_VOCAB);
  if (banned) hits.push(`vocabulário banido: "${banned[0]}"`);
  return hits;
}

// ---------- Deterministic language-consistency guard ----------
// The model (esp. the mini tier) drifts into Portuguese after the PT heading
// heading while the lead stays in the page's language. Stopword counts
// are enough to tell en from pt; tokens shared by both ("a", "as", "no", "do")
// are left out on purpose.

const EN_WORDS = new Set("the and of to is in that it for with are this on be by from was which an or its their they not but have has can".split(" "));
const PT_WORDS = new Set("o os de da das dos que em um uma para com não é por na mais como ao pelo pela se sua seu entre também".split(" "));

type Lang = "en" | "pt" | "?";

export function detectLang(text: string): Lang {
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? [];
  let en = 0;
  let pt = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    else if (PT_WORDS.has(w)) pt++;
  }
  if (en + pt < 6) return "?";
  if (en >= 2 * pt) return "en";
  if (pt >= 2 * en) return "pt";
  return "?";
}

// Returns a description of each part that is not in the source language, or [] if consistent.
export function languageMismatches(sourceText: string, fields: { summary: string; body: string }): string[] {
  const target = detectLang(sourceText);
  if (target === "?") return [];
  // Split at the first "## " heading, even when the model glued it to the end of a paragraph.
  const cut = fields.body.search(/##\s/);
  const lead = cut < 0 ? fields.body : fields.body.slice(0, cut);
  const fichamento = cut < 0 ? "" : fields.body.slice(cut);
  const parts: [string, string][] = [
    ["resumo", lead],
    ["fichamento", fichamento],
    ["summary", fields.summary],
  ];
  const out: string[] = [];
  for (const [name, text] of parts) {
    const lang = detectLang(text);
    if (lang !== "?" && lang !== target) out.push(`${name} em ${lang}`);
  }
  // One word is too little for detectLang, so the heading is checked by name.
  const heading = fichamento.match(/^##\s*([^\n]*)/)?.[1].trim().toLowerCase() ?? "";
  const expected = target === "en" ? "reading notes" : "fichamento";
  if (heading && heading !== expected) out.push(`heading "${heading}" (esperado "${expected}")`);
  return out.length ? [`língua-alvo ${target}; ${out.join(", ")}`] : [];
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

type ParsedFields = Omit<WebclipSummaryResult, "lexicalWarnings" | "model" | "usage" | "has_commentary">;

function parseFields(raw: string): ParsedFields {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
  const language = typeof obj.language === "string" && obj.language.trim() ? obj.language.trim() : "pt";
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  const tags = Array.isArray(obj.tags) ? (obj.tags as unknown[]).map(String).filter(Boolean) : [];

  if (!slug) errs.push("slug ausente/vazio");
  if (!title) errs.push("title ausente");
  if (!summary) errs.push("summary ausente");
  if (!body) errs.push("body ausente");
  if (!/^##\s+\S/m.test(body)) errs.push("body sem a heading '## ' do fichamento numa linha própria");
  if (tags.length === 0) errs.push("tags vazias");
  if (errs.length) throw new Error("validação falhou: " + errs.join("; "));

  return { slug, title, summary, tags, language, body };
}

export async function handleWebclipSummary(
  req: WebclipSummaryRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<WebclipSummaryResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];

  const modelChain = resolveModelChain(req.model, req.fallbackModels, PRESET_MODELS, config.defaultModels);
  const deadline = req.timeoutMs ? Date.now() + req.timeoutMs : undefined;

  const result = await factory.completeWithFallback(
    { model: "", messages, maxTokens: config.maxOutputTokens, temperature: 0.2, deadline },
    modelChain,
  );

  let fields: ParsedFields;
  let model = result.model;
  let usage = result.usage;
  let lastContent = result.content;
  const addUsage = (u: typeof usage) =>
    u && usage
      ? { promptTokens: usage.promptTokens + u.promptTokens, completionTokens: usage.completionTokens + u.completionTokens }
      : u ?? usage;

  try {
    fields = parseFields(result.content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[webclip-summary] parse falhou (${reason}); head: ${JSON.stringify(result.content.slice(0, 300))}`);
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
      { model: "", messages: repairMessages, maxTokens: config.maxOutputTokens, temperature: 0, deadline },
      modelChain,
    );
    fields = parseFields(retry.content);
    model = retry.model;
    usage = addUsage(retry.usage);
    lastContent = retry.content;
  }

  // Mixed-language notes are never returned: one repair turn, then a hard error.
  const mixed = languageMismatches(req.text, fields);
  if (mixed.length) {
    console.log(`[webclip-summary] idioma misto (${mixed.join("; ")}); pedindo reescrita`);
    const langMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: lastContent },
      {
        role: "user",
        content:
          `Sua resposta misturou línguas (${mixed.join("; ")}). ` +
          "A nota inteira precisa estar na língua do TEXTO BRUTO: resumo, heading, cada item do fichamento, summary e tags. " +
          '(Em inglês a heading é "## Reading notes".) Responda novamente APENAS com o objeto JSON completo.',
      },
    ];
    const retry = await factory.completeWithFallback(
      { model: "", messages: langMessages, maxTokens: config.maxOutputTokens, temperature: 0, deadline },
      modelChain,
    );
    fields = parseFields(retry.content);
    model = retry.model;
    usage = addUsage(retry.usage);
    const still = languageMismatches(req.text, fields);
    if (still.length) throw new Error(`idioma misto após reescrita: ${still.join("; ")}`);
  }

  return {
    ...fields,
    has_commentary: false,
    lexicalWarnings: lexicalCheck(fields.body, fields.language),
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
