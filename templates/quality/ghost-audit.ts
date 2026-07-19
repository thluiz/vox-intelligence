import type {
  ChatMessage,
  OpenAIChatResponse,
} from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

// Ghost-writer structural/semantic audit for Scholion notes.
// Counterpart of the deterministic /style-test (regex/lexical). This preset
// catches what regex cannot: aphoristic closers, three-beat rhythm, indirect
// negation the lexical regex misses, mechanical parallelism, fabricated
// experience/scenes, meta-narration, redundant taglines, dash-for-effect, and
// source-or-silence gaps. Canonical checklist: ghost-writer SKILL.md — keep
// in sync when that file changes.
//
// Reliability notes:
// - Invalid JSON from the model triggers ONE repair round-trip before failing.
//   (A hard failure means HTTP 502, which the commit gate treats as fail-open —
//   so parse failures must be rare, not routine.)
// - Every finding's quote is located in the note server-side; `line` is the
//   1-based line number, or null when the quote could not be found verbatim
//   (possible model hallucination — treat those findings with skepticism).
// - `strict: true` runs the two preset models independently and unions their
//   findings. Use for pre-publication audits where a false green costs more.

export interface GhostAuditRequest {
  // Raw markdown of the note (frontmatter + body), or just the body.
  content: string;
  // Optional slug/path, only used for reporting context.
  slug?: string;
  // Run the two preset models independently and union the findings.
  strict?: boolean;
  model?: string;
  fallbackModels?: string[];
}

export interface GhostAuditFinding {
  // Verbatim quote of the offending passage so the caller can locate it.
  quote: string;
  // Which checklist test fired (short label).
  rule: string;
  // "block" = clear voice/source violation; "warn" = candidate, author decides.
  severity: "block" | "warn";
  // Positive, surgical rewrite suggestion (PT-BR), or how to fix.
  suggestion: string;
  // 1-based line of the quote in the submitted content; null = quote not
  // located verbatim (possible hallucination).
  line: number | null;
}

export interface GhostAuditParsed {
  // green = nada a corrigir; yellow = warnings; red = violações claras / fonte faltando.
  verdict: "green" | "yellow" | "red";
  findings: GhostAuditFinding[];
  summary: string;
}

const SYSTEM_PROMPT = `Você é o auditor de voz do Scholion, aplicando o filtro anti-IA do ghost-writer do Thiago Silva (Moy Chi Yau Si). Recebe o markdown de UMA nota e devolve um relatório JSON de violações estruturais e semânticas de voz.

NÃO duplique o /style-test (que já pega, por regex: PT-EU, vocabulário banido token-a-token, contagem de travessões, hedges, frontmatter, datas). Foque no que SÓ leitura crítica parágrafo a parágrafo pega. Leia cada parágrafo aplicando CADA teste abaixo.

## Testes (reporte cada ocorrência)

1. FECHO_AFORISTICO — parágrafo que termina num mini-punch sintetizador, frase "esperta"/inversão clever que repete o que o parágrafo já disse. Ex: "O fluxo está no método de quem deriva, não nas palavras." Se a frase soa inteligente demais ou fecha com chave de ouro, é candidata a corte.
2. TAGLINE_REDUNDANTE — slogan de uma frase que resume o parágrafo anterior. Bold já é o takeaway; não precisa de reforço.
3. TRES_BATIDAS — "X. Twist. Y." separando em três frases curtas o que poderia ser uma com conjunção. Ritmo em três atos é performance, não a secura do autor.
4. NEGATIVA_INDIRETA — "não é X e sim Y", "não por A e sim por B", "não é que X, mas Y". Negar para depois afirmar quando dá para afirmar direto. (A regex do style-test só pega "não é/são/tem… ,/— é"; pegue as variantes que escapam, ex. "não por método e sim por acaso".)
5. PARALELISMO_MECANICO — listas onde cada item tem estrutura gramatical idêntica, ou termos genéricos (proteger/guiar/ensinar) que parecem estrutura mas estão vazios.
6. FALSA_EXPERIENCIA — simula vivência do autor em primeira pessoa que ele não relatou ("já vi", "lembro de quando", cena pessoal inventada). Em nota factual/erudita, qualquer "eu vivi" sem fonte é suspeito.
7. META_NARRACAO — anuncia a estrutura em vez de entregá-la: "em três movimentos", "um caso vale por todos", "o ponto é paradoxal", "vale notar".
8. MOLDURA_NARRADOR — fechamento tipo redação: "X propõe A; Y mostra B", narrador resumindo quem disse o quê.
9. TRAVESSAO_DE_EFEITO — travessão (—), traço (–), hífen ou dois-pontos usado em PROSA CORRENTE como pausa dramática (setup→punch) ou como inciso removível: se a frase segue gramatical ao trocar o travessão por ponto final, ou ao apagar o trecho entre dois travessões, é violação. Só escapa o inciso genuíno cuja remoção quebra a gramática. severity "block": este autor não usa travessão de efeito, então qualquer travessão de efeito em prosa reprova a nota (red). NÃO reporte travessões que estejam (a) em títulos de fonte no frontmatter, (b) dentro de bloco de citação (>) ou de código reproduzindo dado/marcador/saída de verbete, (c) em glosas, listas de acepção, tabelas de formas ou blocos de fonologia de ficha de caractere — esses não são prosa autoral.
10. EDITORIALIZACAO — narrar o efeito da história ("a gente sente o peso", "isso muda tudo") em vez de deixar o leitor sentir.
11. EFEITO_ABSTRATO — "colocações relevantes", "contribuição importante" em vez do conteúdo concreto do que foi dito/feito.
12. SOURCE_OR_SILENCE — afirmação factual (etimologia, datação, atribuição, citação, glosa, número) apresentada como fato assentado, SEM fonte inline, SEM cobertura no bloco sources do frontmatter, E SEM link para outra nota. Severity "block". DUAS EXCEÇÕES que NÃO são violação, não marque: (a) afirmação conectiva ancorada por link para outra nota Scholion — wikilink [[slug]] / [[slug|texto]] OU markdown [texto](/notes/slug) — conta como fonte: a citação vive na nota linkada, que você não vê aqui. (b) em doc de pesquisa, item marcado com ⚠ é provisório-reconhecido pelo autor (a marca já declara "fonte ainda não verificada"). Só é violação a afirmação dada como fato verificado, sem ⚠, sem fonte e sem link.
13. VOZ_GENERICA — se, tirando o nome do autor, o texto poderia ter sido escrito por qualquer IA acadêmica balanceada, aponte o trecho mais sem-voz.
14. PT_EU — qualquer português europeu que escapou ("facto", "está-se", "comboio", ortografia/sintaxe lusitana). severity "block".
15. CENA_FABRICADA — cena, anedota, diálogo ou "exemplo concreto" impessoal sem ancoragem em material do autor: descrição genérica de oralidade ("um termo entra antes pelo ouvido"), cena tipo-categórico ("alguém em uma aula pergunta..."), anedota sem nome/data/lugar, diálogo sem fonte. Diferente de FALSA_EXPERIENCIA (1ª pessoa): aqui a invenção é impessoal. Se a cena não tem marca de origem (transcript, fala citada, fonte, link), reporte.
16. REDUNDANCIA_POS_BOLD — parágrafo logo após uma frase em **bold** que apenas elabora o que o bold já disse. Bold é o takeaway; parágrafo de reforço é corte.
17. CONDICIONAL_VERBOSA — formulação condicional/pleonástica quando a direta cabe: "era uma das premissas que alguém gostaria que fosse cumprida para X" → "era um dos requisitos para X".
18. ESCALA_TEMPORAL — moldura temporal civilizacional ("no século XXI", "na história da humanidade") aplicada a arco pessoal. Casar a moldura com a escala da história: "nos anos seguintes", "logo depois".
19. CITACAO_VERBATIM_NAO_CONFIRMADA — fala entre aspas atribuída a pessoa viva do círculo do autor (Si Fu, mestres, participantes de encontro), provavelmente vinda de transcrição automática, sem marca de confirmação. Whisper erra sons próximos (corta/recorta, legar/negar). Severity "warn": sugerir confirmar com quem estava presente antes de publicar.

## Sensibilidade a categoria

Leia o frontmatter. Se \`category: etymology\` ou \`category: disciple\` (notas de referência filológica), o abatimento vale APENAS para a estrutura de verbete: glosas de dicionário, listas de acepções, tabelas de formas, blocos de fonologia. Sobre ESSA estrutura, não reporte TRAVESSAO_DE_EFEITO nem PARALELISMO_MECANICO.

O abatimento NÃO se estende à prosa. Todo parágrafo de prosa corrente do corpo recebe escrutínio completo, incluindo TRAVESSAO_DE_EFEITO, mesmo numa nota \`category: etymology\`. Uma nota \`category: etymology\` que na verdade é ensaio/prosa metodológica (não uma ficha de caractere) não recebe abatimento nenhum: trate-a como prosa comum. Na dúvida entre verbete e prosa, trate como prosa e reporte.

## Regras de saída

- Cite SEMPRE o trecho verbatim (campo "quote") para o chamador localizar. Copie o trecho EXATAMENTE como está na nota, sem parafrasear nem corrigir.
- "suggestion" deve ser uma reescrita cirúrgica POSITIVA em PT-BR, ou instrução clara de corte. Não reescreva a nota inteira.
- Não invente violação para parecer rigoroso. Se o parágrafo está limpo, não reporte nada dele. Um relatório honesto pode vir vazio.
- SOURCE_OR_SILENCE, PT_EU e TRAVESSAO_DE_EFEITO (em prosa corrente) são sempre severity "block". Os demais geralmente "warn" (o autor decide), salvo flagrante.
- verdict: "red" se houver QUALQUER finding "block"; "yellow" se só houver "warn"; "green" se findings vazio.

Responda APENAS com JSON válido, sem cercas de código, neste formato:
{
  "verdict": "green" | "yellow" | "red",
  "findings": [
    { "quote": "trecho verbatim da nota", "rule": "FECHO_AFORISTICO", "severity": "warn", "suggestion": "reescrita ou corte em PT-BR" }
  ],
  "summary": "1-2 frases: o padrão de fundo, se houver (ex.: 'quase todo parágrafo fecha num mini-punch')."
}`;

const REPAIR_PROMPT =
  "Sua resposta anterior não é JSON válido. Responda novamente APENAS com o JSON no formato especificado, sem cercas de código e sem nenhum texto fora do JSON.";

function buildUserPrompt(req: GhostAuditRequest): string {
  const parts: string[] = [];
  if (req.slug) parts.push(`# Nota: ${req.slug}`);
  parts.push("Audite o markdown abaixo aplicando todos os testes. Reporte só o que de fato viola.");
  parts.push("");
  parts.push("```markdown");
  parts.push(req.content);
  parts.push("```");
  return parts.join("\n");
}

const collapseWs = (s: string) => s.replace(/\s+/g, " ").trim();

// Locate a (possibly loosely-quoted) passage in the note. Returns the 1-based
// line number of the first line of the match, or null when not found.
function locateQuote(content: string, quote: string): number | null {
  if (!quote) return null;
  const idx = content.indexOf(quote);
  if (idx !== -1) return content.slice(0, idx).split("\n").length;

  // Whitespace-tolerant fallback: slide a window of up to 6 lines.
  const target = collapseWs(quote);
  if (!target) return null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let acc = "";
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      acc = acc ? `${acc} ${collapseWs(lines[j])}` : collapseWs(lines[j]);
      if (acc.includes(target)) return i + 1;
    }
  }
  return null;
}

function parseResponse(content: string, noteContent: string): GhostAuditParsed {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  const verdict = ["green", "yellow", "red"].includes(parsed.verdict)
    ? parsed.verdict
    : "yellow";

  const findings: GhostAuditFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f: Record<string, unknown>) => {
        const quote = String(f.quote || "");
        return {
          quote,
          rule: String(f.rule || "UNSPECIFIED"),
          severity: f.severity === "block" ? ("block" as const) : ("warn" as const),
          suggestion: String(f.suggestion || ""),
          line: locateQuote(noteContent, quote),
        };
      })
    : [];

  // Coerência: se há qualquer block, verdict é red.
  const hasBlock = findings.some((f) => f.severity === "block");
  const finalVerdict = hasBlock ? "red" : findings.length === 0 ? "green" : verdict;

  return {
    verdict: finalVerdict,
    findings,
    summary: String(parsed.summary || ""),
  };
}

function mergeParsed(a: GhostAuditParsed, b: GhostAuditParsed): GhostAuditParsed {
  const key = (f: GhostAuditFinding) => `${f.rule}|${collapseWs(f.quote).toLowerCase()}`;
  const seen = new Set(a.findings.map(key));
  const findings = [...a.findings];
  for (const f of b.findings) {
    if (!seen.has(key(f))) {
      seen.add(key(f));
      findings.push(f);
    }
  }
  const hasBlock = findings.some((f) => f.severity === "block");
  return {
    verdict: hasBlock ? "red" : findings.length === 0 ? "green" : "yellow",
    findings,
    summary: [a.summary, b.summary].filter(Boolean).join(" | "),
  };
}

interface AuditRun {
  parsed: GhostAuditParsed;
  model: string;
  finishReason: "stop" | "length" | "error";
  usage?: { promptTokens: number; completionTokens: number };
}

export async function handleGhostAudit(
  req: GhostAuditRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<{ response: OpenAIChatResponse; parsed: GhostAuditParsed }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];

  // Preset pins gpt-5.2: only model in testing that reliably catches
  // source-or-silence (the gravest Scholion violation). opus-4.5 as fallback.
  // Callers can still override via req.model / req.fallbackModels.
  // strict mode runs the first two chain entries independently and unions.
  const PRESET_MODELS = ["openrouter/openai/gpt-5.2", "openrouter/anthropic/claude-opus-4.5"];
  const modelChain = resolveModelChain(req.model, req.fallbackModels, PRESET_MODELS, config.defaultModels);

  const runOnce = async (chain: string[]): Promise<AuditRun> => {
    const result = await factory.completeWithFallback(
      { model: "", messages, maxTokens: config.maxOutputTokens, temperature: 0.2 },
      chain,
    );
    try {
      return {
        parsed: parseResponse(result.content, req.content),
        model: result.model,
        finishReason: result.finishReason,
        usage: result.usage,
      };
    } catch (_err) {
      // One repair round-trip: hand the invalid output back and ask for JSON only.
      const repairMessages: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: result.content },
        { role: "user", content: REPAIR_PROMPT },
      ];
      const retry = await factory.completeWithFallback(
        { model: "", messages: repairMessages, maxTokens: config.maxOutputTokens, temperature: 0 },
        chain,
      );
      return {
        parsed: parseResponse(retry.content, req.content),
        model: retry.model,
        finishReason: retry.finishReason,
        usage: retry.usage
          ? {
              promptTokens: (result.usage?.promptTokens ?? 0) + retry.usage.promptTokens,
              completionTokens: (result.usage?.completionTokens ?? 0) + retry.usage.completionTokens,
            }
          : result.usage,
      };
    }
  };

  let run: AuditRun;

  if (req.strict && modelChain.length > 1) {
    const [ra, rb] = await Promise.allSettled([
      runOnce([modelChain[0]]),
      runOnce(modelChain.slice(1)),
    ]);
    if (ra.status === "fulfilled" && rb.status === "fulfilled") {
      run = {
        parsed: mergeParsed(ra.value.parsed, rb.value.parsed),
        model: `${ra.value.model}+${rb.value.model}`,
        finishReason: "stop",
        usage: {
          promptTokens: (ra.value.usage?.promptTokens ?? 0) + (rb.value.usage?.promptTokens ?? 0),
          completionTokens:
            (ra.value.usage?.completionTokens ?? 0) + (rb.value.usage?.completionTokens ?? 0),
        },
      };
    } else if (ra.status === "fulfilled" || rb.status === "fulfilled") {
      const ok = (ra.status === "fulfilled" ? ra : rb) as PromiseFulfilledResult<AuditRun>;
      run = ok.value;
      run.parsed.summary = [
        run.parsed.summary,
        "(strict degradado: um dos dois modelos falhou; findings de auditor único)",
      ]
        .filter(Boolean)
        .join(" ");
    } else {
      throw (ra as PromiseRejectedResult).reason;
    }
  } else {
    run = await runOnce(modelChain);
  }

  const parsed = run.parsed;
  const id = `vi-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const response: OpenAIChatResponse = {
    id,
    object: "chat.completion",
    model: run.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(parsed) },
        finish_reason: run.finishReason === "length" ? "length" : "stop",
      },
    ],
    usage: run.usage
      ? {
          prompt_tokens: run.usage.promptTokens,
          completion_tokens: run.usage.completionTokens,
          total_tokens: run.usage.promptTokens + run.usage.completionTokens,
        }
      : undefined,
  };

  return { response, parsed };
}
