/**
 * etymology-note.ts — Scholion Chinese etymology note preset
 *
 * Synthesises ONE Scholion etymology note (PT-BR markdown, frontmatter + body)
 * from the raw dump of 7 sources collected by the Scholion crawler
 * (crawl-radical.mjs). Replaces the `claude -p` step of the radicals pipeline.
 *
 * Contract with the model (same as the old pipeline):
 *   line 1: `SLUG: etimologia-de-<jyutping>-<pinyin>-<hex>`
 *   line 2: blank
 *   line 3+: the full note, starting at `---` (frontmatter)
 *
 * The server parses/validates that contract and does ONE repair round-trip on
 * malformed output before failing (mirrors ghost-audit.ts reliability notes).
 *
 * Prompt caching: system prompt is fully static; the user prompt starts with
 * the gabarito (identical across calls) so the variable part (char + dump)
 * comes last.
 */

import type { ChatMessage } from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

export interface EtymologyNoteRequest {
  // The target character, e.g. "斗".
  char: string;
  // Kangxi radical number (1-214), as string or number.
  radicalNum: string | number;
  // Lowercase hex codepoint, e.g. "6597".
  hex: string;
  // Frontmatter date, ISO with offset — computed by the CALLER with the real
  // local clock (never invented server-side).
  date: string;
  // Full markdown of the model note (水) the output must replicate.
  gabarito: string;
  // Clean crawler dump of the 7 sources.
  dump: string;
  model?: string;
  fallbackModels?: string[];
}

export interface EtymologyNoteResult {
  slug: string;
  note: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Same chain the gateway defaults to: deepseek-v3.2 is the cheap workhorse and
// strong on Chinese; gpt-5.2 as quality fallback. Callers can override.
const PRESET_MODELS = ["openrouter/deepseek/deepseek-v3.2", "openrouter/openai/gpt-5.2"];

const SYSTEM_PROMPT = `Você é um filólogo que redige UMA nota de etimologia de caractere chinês para o Scholion, em PORTUGUÊS BRASILEIRO, a partir de DADOS BRUTOS de 7 fontes. Replique EXATAMENTE o formato do MODELO fornecido (mesmas seções ####, tabela de evolução, bloco de fonologia, seção final "Divergências entre fontes").

REGRAS INEGOCIÁVEIS:
- Source-or-silence: só afirme o que está nos DADOS. Campo sem dado → "(não obtido — <motivo>)". NUNCA invente datação, glosa, autoria ou reconstrução fonológica.
- Verbatim: definições do chardb (字義) e o texto do 說文 (Shuowen) em chinês original + tradução PT-BR entre parênteses. Transcreva TODAS as acepções numeradas do chardb.
- PT-BR (não PT-EU): registrar, seção, arquivo, caractere, tênue. Não traduza termos técnicos (Shuowen, fanqie, 段注, 中古音, 上古音).
- NÃO editorialize e NÃO vincule a kung fu/linhagem: registro filológico puro.
- Traduza dinastias/scripts/artefatos na tabela de formas. Traduza fonologia: 攝→division, 韻→rhyme, 聲→tone, 母→initial, 反切→fanqie, 等→grade, 開→open, 合→closed, 平→level, 上→rising, 去→departing, 入→entering, 全清→totalmente surda, 次清→aspirada surda, 次濁→sonorante, 全濁→sonora plena.
- Contagem de caracteres derivados: se os DADOS não a trazem, OMITA essa cláusula da abertura (não escreva "não obtido" para ela).
- 段注 (Duan Yucai) quase nunca vem no dump: marque "(não obtido — shuowen.org retornou listagem; zdic.net retornou HTTP 404)".
- 鄭張尚芳 (Zhengzhang) ausente da tabela → "(não retornou dados — ausente da tabela do 小學堂)".
- Atribuição por seção: cada dado citado pertence à fonte do header "## <fonte>" do dump onde ele aparece. Os rótulos 略說, 詳解 e 形義通解 são da CUHK (漢語多功能字庫); o rótulo 今按 é do 小學堂. NUNCA atribua comentário da CUHK ao 小學堂, nem vice-versa.
- No hanziyuan, "Importance by frequency 常用频率: 99999" é valor-sentinela para SEM RANKING — reporte "(sem ranking na fonte)" ou omita a linha; NUNCA interprete o número como frequência alta ou baixa.
- A seção "Divergências entre fontes" registra APENAS divergências atestadas entre as fontes do dump. NÃO acrescente inferências próprias (correspondências fonológicas, deduções históricas, conclusões que nenhuma fonte afirma). Exemplo PROIBIDO: "a leitura dau2 é consistente com o 中古音 (tom 上 → tom 2 cantonês)" — nenhuma fonte afirma essa correspondência; registre as leituras de cada fonte e pare aí.

FRONTMATTER: idêntico ao MODELO, com o date fornecido pelo usuário, exatamente. summary sempre entre aspas simples.
ABERTURA: "É o radical Kangxi nº <N> (<char>, <glosa curta>). <variante do radical, se houver, ex.: 'Como radical à esquerda, assume a forma X.'> Registro filológico, sem vínculo a nome kung fu. Ver [Os 214 radicais Kangxi](/notes/os-214-radicais-kangxi/)."
Linha de identificação após a abertura: "**<char>** — U+<HEX> · 部首 radical: ... · 總筆畫 strokes: ... · 注音 zhuyin: ... · 拼音 pinyin: ... / jyutping: ..." (preencha com os DADOS).

SAÍDA (CRÍTICO — obedeça):
- NÃO explique. NÃO comente antes nem depois. NÃO use cercas de código.
- 1ª linha, exatamente: SLUG: etimologia-de-<jyutping-sem-tom>-<pinyin-sem-diacrítico-sem-tom>-<hex>
- 2ª linha: em branco.
- Da 3ª linha em diante: a nota completa, começando em "---" (frontmatter) e terminando na seção "#### Divergências entre fontes". Nada além da nota.`;

function buildUserPrompt(req: EtymologyNoteRequest): string {
  const hexUp = req.hex.toUpperCase();
  return [
    "===== MODELO (replicar o formato EXATAMENTE) =====",
    req.gabarito,
    "",
    `===== CARACTERE-ALVO =====`,
    `${req.char} · radical Kangxi nº ${req.radicalNum} · U+${hexUp} · hex para o slug: ${req.hex.toLowerCase()} · date do frontmatter: '${req.date}'`,
    "",
    "===== DADOS BRUTOS (7 fontes; texto verbatim) =====",
    req.dump,
  ].join("\n");
}

// Models often leave the jyutping tone digit in the slug (dau2 → dau); strip
// digits from the syllable segments deterministically instead of burning a
// repair round-trip on it.
function normalizeSlug(slug: string): string {
  const m = slug.match(/^etimologia-de-([a-z0-9]+)-([a-z0-9]+)-([0-9a-f]+)$/);
  if (!m) return slug;
  return `etimologia-de-${m[1].replace(/[0-9]/g, "")}-${m[2].replace(/[0-9]/g, "")}-${m[3]}`;
}

// Parse + minimal validation of the SLUG/note contract. Throws with a precise
// reason (fed back to the model on the repair round-trip).
function parseNoteResponse(raw: string, hex: string): { slug: string; note: string } {
  const slugMatch = raw.match(/SLUG:\s*(etimologia-de-[a-z0-9]+-[a-z0-9]+-[0-9a-f]+)/i);
  const fmStart = raw.indexOf("\n---");
  const firstDash = raw.trimStart().startsWith("---")
    ? raw.indexOf("---")
    : fmStart >= 0 ? fmStart + 1 : -1;
  if (!slugMatch) throw new Error("saída sem linha 'SLUG: etimologia-de-...' válida");
  if (firstDash < 0) throw new Error("saída sem frontmatter começando em '---'");

  const slug = normalizeSlug(slugMatch[1].toLowerCase());
  if (!slug.endsWith(`-${hex.toLowerCase()}`)) {
    throw new Error(`slug '${slug}' não termina no hex '${hex.toLowerCase()}'`);
  }

  let note = raw.slice(firstDash).trim();
  note = note.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "").trim() + "\n";
  // Convenção Scholion: summary entre aspas SIMPLES (YAML). Requote
  // deterministicamente quando o modelo usa aspas duplas.
  note = note.replace(/^summary:\s*"(.*)"\s*$/m, (_all, v: string) =>
    `summary: '${v.replace(/\\"/g, '"').replace(/'/g, "''")}'`);

  const errs: string[] = [];
  if (!note.startsWith("---")) errs.push("não começa com frontmatter");
  if (!/#### Divergências entre fontes/.test(note)) errs.push("sem seção '#### Divergências entre fontes'");
  if (!/^title:\s*"/m.test(note)) errs.push("sem title entre aspas duplas");
  if (!/^date:\s*'/m.test(note)) errs.push("sem date entre aspas simples");
  if (!/^summary:\s*'/m.test(note)) errs.push("summary sem aspas simples");
  if (errs.length) throw new Error("validação falhou: " + errs.join("; "));

  return { slug, note };
}

export async function handleEtymologyNote(
  req: EtymologyNoteRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<EtymologyNoteResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];

  const modelChain = resolveModelChain(req.model, req.fallbackModels, PRESET_MODELS, config.defaultModels);

  const result = await factory.completeWithFallback(
    { model: "", messages, maxTokens: config.maxOutputTokens, temperature: 0.2 },
    modelChain,
  );

  let parsed: { slug: string; note: string };
  let model = result.model;
  let usage = result.usage;
  try {
    parsed = parseNoteResponse(result.content, req.hex);
  } catch (err) {
    // One repair round-trip: hand back the invalid output with the exact reason.
    const reason = err instanceof Error ? err.message : String(err);
    console.log(
      `[etymology-note] ${req.char}: parse falhou (${reason}); ` +
      `head da saída: ${JSON.stringify(result.content.slice(0, 300))}`,
    );
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content:
          `Sua resposta anterior violou o contrato de saída (${reason}). ` +
          "Responda novamente APENAS com: linha 1 'SLUG: ...', linha 2 em branco, " +
          "e a nota completa a partir do '---' do frontmatter. Sem cercas de código, sem comentários.",
      },
    ];
    const retry = await factory.completeWithFallback(
      { model: "", messages: repairMessages, maxTokens: config.maxOutputTokens, temperature: 0 },
      modelChain,
    );
    let retryParsed: { slug: string; note: string };
    try {
      retryParsed = parseNoteResponse(retry.content, req.hex);
    } catch (err2) {
      const reason2 = err2 instanceof Error ? err2.message : String(err2);
      console.log(
        `[etymology-note] ${req.char}: repair também falhou (${reason2}); ` +
        `head da saída: ${JSON.stringify(retry.content.slice(0, 300))}`,
      );
      throw err2;
    }
    parsed = retryParsed;
    model = retry.model;
    usage = retry.usage && result.usage
      ? {
          promptTokens: result.usage.promptTokens + retry.usage.promptTokens,
          completionTokens: result.usage.completionTokens + retry.usage.completionTokens,
        }
      : retry.usage ?? result.usage;
  }

  return {
    slug: parsed.slug,
    note: parsed.note,
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
