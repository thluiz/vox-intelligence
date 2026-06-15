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
// experience, meta-narration, redundant taglines, dash-for-effect, and
// source-or-silence gaps. Canonical checklist: ghost-writer SKILL.md — keep
// in sync when that file changes.

export interface GhostAuditRequest {
  // Raw markdown of the note (frontmatter + body), or just the body.
  content: string;
  // Optional slug/path, only used for reporting context.
  slug?: string;
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
6. FALSA_EXPERIENCIA — simula vivência do autor que ele não relatou ("já vi", "lembro de quando", cena pessoal inventada). Em nota factual/erudita, qualquer "eu vivi" sem fonte é suspeito.
7. META_NARRACAO — anuncia a estrutura em vez de entregá-la: "em três movimentos", "um caso vale por todos", "o ponto é paradoxal", "vale notar".
8. MOLDURA_NARRADOR — fechamento tipo redação: "X propõe A; Y mostra B", narrador resumindo quem disse o quê.
9. TRAVESSAO_DE_EFEITO — travessão (ou traço/hífen/dois-pontos) usado como pausa dramática setup→punch, removível por ponto final sem perder sentido. Só é aceitável o inciso genuíno que, removido, quebra a gramática.
10. EDITORIALIZACAO — narrar o efeito da história ("a gente sente o peso", "isso muda tudo") em vez de deixar o leitor sentir.
11. EFEITO_ABSTRATO — "colocações relevantes", "contribuição importante" em vez do conteúdo concreto do que foi dito/feito.
12. SOURCE_OR_SILENCE — afirmação factual (etimologia, datação, atribuição, citação, glosa, número) apresentada como fato assentado, SEM fonte inline, SEM cobertura no bloco sources do frontmatter, E SEM link para outra nota. Severity "block". DUAS EXCEÇÕES que NÃO são violação, não marque: (a) afirmação conectiva ancorada por link para outra nota Scholion — wikilink [[slug]] / [[slug|texto]] OU markdown [texto](/notes/slug) — conta como fonte: a citação vive na nota linkada, que você não vê aqui. (b) em doc de pesquisa, item marcado com ⚠ é provisório-reconhecido pelo autor (a marca já declara "fonte ainda não verificada"). Só é violação a afirmação dada como fato verificado, sem ⚠, sem fonte e sem link.
13. VOZ_GENERICA — se, tirando o nome do autor, o texto poderia ter sido escrito por qualquer IA acadêmica balanceada, aponte o trecho mais sem-voz.
14. PT_EU — qualquer português europeu que escapou ("facto", "está-se", "comboio", ortografia/sintaxe lusitana). severity "block".

## Regras de saída

- Cite SEMPRE o trecho verbatim (campo "quote") para o chamador localizar.
- "suggestion" deve ser uma reescrita cirúrgica POSITIVA em PT-BR, ou instrução clara de corte. Não reescreva a nota inteira.
- Não invente violação para parecer rigoroso. Se o parágrafo está limpo, não reporte nada dele. Um relatório honesto pode vir vazio.
- SOURCE_OR_SILENCE e PT_EU são sempre severity "block". Os demais geralmente "warn" (o autor decide), salvo flagrante.
- verdict: "red" se houver QUALQUER finding "block"; "yellow" se só houver "warn"; "green" se findings vazio.

Responda APENAS com JSON válido, sem cercas de código, neste formato:
{
  "verdict": "green" | "yellow" | "red",
  "findings": [
    { "quote": "trecho verbatim da nota", "rule": "FECHO_AFORISTICO", "severity": "warn", "suggestion": "reescrita ou corte em PT-BR" }
  ],
  "summary": "1-2 frases: o padrão de fundo, se houver (ex.: 'quase todo parágrafo fecha num mini-punch')."
}`;

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

function parseResponse(content: string): GhostAuditParsed {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  const verdict = ["green", "yellow", "red"].includes(parsed.verdict)
    ? parsed.verdict
    : "yellow";

  const findings: GhostAuditFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f: Record<string, unknown>) => ({
        quote: String(f.quote || ""),
        rule: String(f.rule || "UNSPECIFIED"),
        severity: f.severity === "block" ? "block" : "warn",
        suggestion: String(f.suggestion || ""),
      }))
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
  const PRESET_MODELS = ["openrouter/openai/gpt-5.2", "openrouter/anthropic/claude-opus-4.5"];
  const modelChain = resolveModelChain(req.model, req.fallbackModels, PRESET_MODELS, config.defaultModels);

  const result = await factory.completeWithFallback(
    {
      model: "",
      messages,
      maxTokens: config.maxOutputTokens,
      temperature: 0.2,
    },
    modelChain,
  );

  const parsed = parseResponse(result.content);

  const id = `vi-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const response: OpenAIChatResponse = {
    id,
    object: "chat.completion",
    model: result.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(parsed) },
        finish_reason: result.finishReason === "length" ? "length" : "stop",
      },
    ],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.promptTokens + result.usage.completionTokens,
        }
      : undefined,
  };

  return { response, parsed };
}
