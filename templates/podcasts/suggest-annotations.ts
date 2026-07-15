import type {
  ChatMessage,
  OpenAIChatResponse,
} from "../../types";
import { resolveModelChain } from "../../types";
import type { Config } from "../../config";
import { ProviderFactory } from "../../providers/provider";

export interface SuggestAnnotationsRequest {
  episode: {
    lang?: string;
    summary?: string;
    annotations?: Array<{ ts: string; title: string; description?: string }>;
    transcript: string;
    metadata?: { title?: string; podcast?: string; duration?: string };
    participants?: string[];
  };
  model?: string;
  fallbackModels?: string[];
}

export interface AnnotationSuggestion {
  ts: string;
  tier: "concept" | "data" | "reflection";
  title: string;
  quote: string;
  description: string;
  criterion: string;
  overlap?: string;
}

export interface SuggestAnnotationsResult {
  suggestions: AnnotationSuggestion[];
  stats: {
    total: number;
    concepts: number;
    data: number;
    reflections: number;
    overlaps: number;
  };
}

const PRESET_MODELS = ["openrouter/google/gemini-2.5-flash"];

const SYSTEM_PROMPT_PT = `Você é um analista editorial de podcasts. Recebe o transcript completo de um episódio e deve identificar 8–25 momentos dignos de anotação permanente.

## Critérios de selecção (pelo menos um deve ser satisfeito)
1. **Dados concretos surpreendentes** — estatísticas, números, factos verificáveis que causam impacto
2. **Conceitos-chave nomeados** — termos técnicos, frameworks, teorias introduzidos pela primeira vez
3. **Declarações de impacto / citáveis** — frases com força retórica, soundbites
4. **Revelações ou denúncias** — informação nova, exclusiva ou contra-intuitiva
5. **Conexões não-óbvias** — quando o orador liga dois temas aparentemente desconectados
6. **Momentos de reflexão para posteridade** — passagens com relevância além do contexto imediato
7. **Ideias inusitadas ou fora do tradicional** — reframings originais, imagens conceituais vívidas ou metáforas que iluminam algo comum de forma nova, provocações contra-intuitivas, formulações idiossincráticas do orador (ex.: reduzir uma ideia grandiosa a um detalhe prosaico — "um Deus que cria o universo e te dá um carro"). Priorizar o que é memorável por ser INESPERADO, não só por ser importante.

## Tiers
- "concept" — critérios 2 e 5 (conceitos, frameworks, conexões)
- "data" — critérios 1 e 4 (dados, revelações, factos)
- "reflection" — critérios 3, 6 e 7 (declarações de impacto, reflexões, ideias inusitadas)

## O que NÃO anotar
- Intros, merchandising, despedidas, chamadas à acção
- Repetições de pontos já cobertos
- Comentários meta ("como dizia", "voltando ao tema")
- Piadas sem substância informativa
- Transições genéricas

## Anotações existentes
Se o episódio já tem anotações, indicar sobreposições (threshold: 30 segundos) no campo "overlap". Não duplicar.

## Regras
- Basear TUDO exclusivamente no transcript fornecido. Nunca inventar ou extrapolar
- Ser selectivo: qualidade sobre quantidade (8–25 sugestões)
- Reservar deliberadamente 2–4 das sugestões para as ideias MAIS inusitadas/originais do episódio (critério 7), mesmo que não sejam o tema central. Não encher a lista só com os beats principais e óbvios.
- O campo "description" deve ser uma explicação editorial curta (1-2 frases) de por que este momento é relevante
- O campo "quote" deve conter uma citação directa ou paráfrase fiel do transcript (1-2 frases)
- O campo "criterion" deve indicar qual critério (1-6) a sugestão satisfaz
- Output APENAS JSON válido, sem markdown fences
- Escrever na mesma língua do transcript

## Output Schema
{
  "suggestions": [
    {
      "ts": "HH:MM:SS",
      "tier": "concept" | "data" | "reflection",
      "title": "5-8 palavras",
      "description": "1-2 frases editoriais explicando por que este momento é relevante",
      "quote": "citação directa do transcript (1-2 frases)",
      "criterion": "qual critério satisfaz",
      "overlap": "≈ HH:MM:SS — título (se a <30s de anotação existente)"
    }
  ]
}`;

const SYSTEM_PROMPT_EN = `You are a podcast editorial analyst. You receive the full transcript of an episode and must identify 8–25 moments worthy of permanent annotation.

## Selection criteria (at least one must be satisfied)
1. **Surprising concrete data** — statistics, numbers, verifiable facts that make an impact
2. **Named key concepts** — technical terms, frameworks, theories introduced for the first time
3. **Impact / quotable statements** — phrases with rhetorical force, soundbites
4. **Revelations or exposés** — new, exclusive, or counter-intuitive information
5. **Non-obvious connections** — when the speaker links two seemingly unrelated topics
6. **Moments of reflection for posterity** — passages with relevance beyond the immediate context
7. **Unusual or non-traditional ideas** — original reframings, vivid conceptual images or metaphors that cast something ordinary in a new light, counter-intuitive provocations, idiosyncratic formulations by the speaker (e.g. reducing a grand idea to a prosaic detail — "a God who creates the universe and gives you a car"). Prioritize what is memorable for being UNEXPECTED, not only for being important.

## Tiers
- "concept" — criteria 2 and 5 (concepts, frameworks, connections)
- "data" — criteria 1 and 4 (data, revelations, facts)
- "reflection" — criteria 3, 6 and 7 (impact statements, reflections, unusual ideas)

## What NOT to annotate
- Intros, merchandising, goodbyes, calls to action
- Repetitions of points already covered
- Meta-commentary ("as I was saying", "going back to the topic")
- Jokes without informational substance
- Generic transitions

## Existing annotations
If the episode already has annotations, flag overlaps (threshold: 30 seconds) in the "overlap" field. Do not duplicate.

## Rules
- Base EVERYTHING exclusively on the provided transcript. Never invent or extrapolate
- Be selective: quality over quantity (8–25 suggestions)
- Deliberately reserve 2–4 of the suggestions for the MOST unusual/original ideas in the episode (criterion 7), even if they are not the central topic. Do not fill the list only with the main, obvious beats.
- The "description" field must be a short editorial explanation (1-2 sentences) of why this moment matters
- The "quote" field must contain a direct quote or faithful paraphrase from the transcript (1-2 sentences)
- The "criterion" field must indicate which criterion (1-6) the suggestion satisfies
- Output ONLY valid JSON, no markdown fences
- Write in the same language as the transcript

## Output Schema
{
  "suggestions": [
    {
      "ts": "HH:MM:SS",
      "tier": "concept" | "data" | "reflection",
      "title": "5-8 words",
      "description": "1-2 editorial sentences explaining why this moment matters",
      "quote": "direct quote from transcript (1-2 sentences)",
      "criterion": "which criterion is satisfied",
      "overlap": "≈ HH:MM:SS — title (if within 30s of existing annotation)"
    }
  ]
}`;

function buildUserPrompt(req: SuggestAnnotationsRequest): string {
  const ep = req.episode;
  const parts: string[] = [];

  parts.push(`## Episode: ${ep.metadata?.title ?? "Unknown"}`);
  if (ep.metadata?.podcast) parts.push(`**Podcast**: ${ep.metadata.podcast}`);
  if (ep.participants?.length) parts.push(`**Participants**: ${ep.participants.join(", ")}`);
  if (ep.metadata?.duration) parts.push(`**Duration**: ${ep.metadata.duration}`);
  parts.push("");

  if (ep.summary) {
    parts.push("## Summary");
    parts.push(ep.summary);
    parts.push("");
  }

  parts.push("## Existing Annotations");
  if (ep.annotations?.length) {
    for (const ann of ep.annotations) {
      parts.push(`- ${ann.ts} — ${ann.title}`);
    }
  } else {
    parts.push("None");
  }
  parts.push("");

  parts.push("## Full Transcript");
  parts.push(ep.transcript);

  return parts.join("\n");
}

function parseResponse(content: string): SuggestAnnotationsResult {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  const suggestions: AnnotationSuggestion[] = (parsed.suggestions || parsed).map(
    (item: Record<string, unknown>) => {
      const s: AnnotationSuggestion = {
        ts: String(item.ts || "00:00:00"),
        tier: (["concept", "data", "reflection"].includes(String(item.tier))
          ? String(item.tier)
          : "reflection") as "concept" | "data" | "reflection",
        title: String(item.title || ""),
        description: String(item.description || ""),
        quote: String(item.quote || ""),
        criterion: String(item.criterion || ""),
      };
      if (item.overlap) s.overlap = String(item.overlap);
      return s;
    },
  );

  const stats = {
    total: suggestions.length,
    concepts: suggestions.filter((s) => s.tier === "concept").length,
    data: suggestions.filter((s) => s.tier === "data").length,
    reflections: suggestions.filter((s) => s.tier === "reflection").length,
    overlaps: suggestions.filter((s) => s.overlap).length,
  };

  return { suggestions, stats };
}

export async function handleSuggestAnnotations(
  req: SuggestAnnotationsRequest,
  factory: ProviderFactory,
  config: Config,
): Promise<{ response: OpenAIChatResponse; parsed: SuggestAnnotationsResult }> {
  const lang = req.episode.lang?.toLowerCase().startsWith("en") ? "en" : "pt";
  const systemPrompt = lang === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_PT;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildUserPrompt(req) },
  ];

  const modelChain = resolveModelChain(
    req.model,
    req.fallbackModels,
    PRESET_MODELS,
    config.defaultModels,
  );

  const result = await factory.completeWithFallback(
    {
      model: "",
      messages,
      maxTokens: config.maxOutputTokens,
      temperature: 0.5,
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
        message: { role: "assistant", content: result.content },
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
