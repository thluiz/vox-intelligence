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

const PRESET_MODELS = ["openrouter/openai/gpt-5.2", "openrouter/google/gemini-2.5-flash"];

const SYSTEM_PROMPT_PT = `Você é um analista editorial de podcasts. Recebe o transcript completo de um episódio e deve identificar quantos momentos forem genuinamente dignos de anotação permanente — a quantidade depende inteiramente da riqueza do episódio: pode ser 1, pode ser 30. Não force um mínimo nem um máximo artificial.

## Critérios de selecção (pelo menos um deve ser satisfeito)
1. **Dados concretos surpreendentes** — estatísticas, números, factos verificáveis que causam impacto
2. **Conceitos-chave nomeados** — termos técnicos, frameworks, teorias introduzidos pela primeira vez
3. **Declarações de impacto / citáveis** — frases com força retórica, soundbites
4. **Revelações ou denúncias** — informação nova, exclusiva ou contra-intuitiva
5. **Conexões não-óbvias** — quando o orador liga dois temas aparentemente desconectados
6. **Momentos de reflexão para posteridade** — passagens com relevância além do contexto imediato
7. **Ideias inusitadas ou fora do tradicional** — reframings originais, imagens conceituais vívidas ou metáforas que iluminam algo comum de forma nova, provocações contra-intuitivas, formulações idiossincráticas do orador (ex.: reduzir uma ideia grandiosa a um detalhe prosaico — "um Deus que cria o universo e te dá um carro"). Priorizar o que é memorável por ser INESPERADO, não só por ser importante.
8. **Anedota ilustrativa** — um causo ou história pessoal curta que dramatiza de forma vívida um argumento central do episódio, mesmo sem conter um dado novo ou uma frase de efeito isolada (ex.: um episódio de trabalho que ilustra na prática por que uma técnica ou crença comum falha).

## Tiers
- "concept" — critérios 2 e 5 (conceitos, frameworks, conexões)
- "data" — critérios 1 e 4 (dados, revelações, factos)
- "reflection" — critérios 3, 6, 7 e 8 (declarações de impacto, reflexões, ideias inusitadas, anedotas ilustrativas)

## O que NÃO anotar
- Intros, merchandising, despedidas, chamadas à acção
- Repetições de pontos já cobertos
- Comentários meta ("como dizia", "voltando ao tema")
- Piadas sem substância informativa
- Transições genéricas

⚠️ Não exclua um trecho só por estar dentro de um segmento tipicamente de baixo valor (quadro fixo de recomendações, merchandising, bate-papo solto). Julgue pelo CONTEÚDO: se algo dentro desse segmento se conecta ao tema central do episódio (ver Summary), ele continua elegível.

## Anotações existentes
Se o episódio já tem anotações, indicar sobreposições (threshold: 30 segundos) no campo "overlap". Não duplicar.

## Regras
- Basear TUDO exclusivamente no transcript fornecido. Nunca inventar ou extrapolar
- Ser selectivo: qualidade sobre quantidade. Um episódio raso ou curto pode render poucas sugestões (ou nenhuma); um episódio denso pode render muitas. Nunca preencher a lista só para atingir uma contagem, e nunca se conter só para ficar abaixo de um teto artificial.
- Se o episódio tiver ideias inusitadas/originais (critério 7), incluí-las mesmo que não sejam o tema central. Não encher a lista só com os beats principais e óbvios — mas também não inventar uma ideia inusitada que não exista no transcript só para preencher.
- Ao encontrar um bloco de conversa longo (>60-90s) sobre o mesmo tópico, procure activamente por MAIS DE UM momento citável dentro dele — falas diferentes no mesmo bloco podem satisfazer critérios diferentes (ex.: uma frase de impacto e, minutos depois no mesmo assunto, um dado concreto). Não colapse um bloco temático inteiro numa única sugestão só porque já cobriu o tópico uma vez
- Distribua as sugestões proporcionalmente por TODA a duração do episódio. Ao chegar ao último quarto do transcript, mantenha o mesmo rigor de escrutínio do início — é comum haver queda de cobertura perto do fim
- O campo "description" deve ser uma explicação editorial curta (1-2 frases) de por que este momento é relevante
- O campo "quote" deve conter uma citação directa ou paráfrase fiel do transcript (1-2 frases)
- O campo "criterion" deve indicar qual critério (1-8) a sugestão satisfaz
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

const SYSTEM_PROMPT_EN = `You are a podcast editorial analyst. You receive the full transcript of an episode and must identify however many moments are genuinely worthy of permanent annotation — the count depends entirely on how rich the episode is: it could be 1, it could be 30. Do not force an artificial minimum or maximum.

## Selection criteria (at least one must be satisfied)
1. **Surprising concrete data** — statistics, numbers, verifiable facts that make an impact
2. **Named key concepts** — technical terms, frameworks, theories introduced for the first time
3. **Impact / quotable statements** — phrases with rhetorical force, soundbites
4. **Revelations or exposés** — new, exclusive, or counter-intuitive information
5. **Non-obvious connections** — when the speaker links two seemingly unrelated topics
6. **Moments of reflection for posterity** — passages with relevance beyond the immediate context
7. **Unusual or non-traditional ideas** — original reframings, vivid conceptual images or metaphors that cast something ordinary in a new light, counter-intuitive provocations, idiosyncratic formulations by the speaker (e.g. reducing a grand idea to a prosaic detail — "a God who creates the universe and gives you a car"). Prioritize what is memorable for being UNEXPECTED, not only for being important.
8. **Illustrative anecdote** — a short personal story or anecdote that vividly dramatizes a central argument of the episode, even without containing new data or a standalone soundbite (e.g. a work story that shows in practice why a common technique or belief fails).

## Tiers
- "concept" — criteria 2 and 5 (concepts, frameworks, connections)
- "data" — criteria 1 and 4 (data, revelations, facts)
- "reflection" — criteria 3, 6, 7 and 8 (impact statements, reflections, unusual ideas, illustrative anecdotes)

## What NOT to annotate
- Intros, merchandising, goodbyes, calls to action
- Repetitions of points already covered
- Meta-commentary ("as I was saying", "going back to the topic")
- Jokes without informational substance
- Generic transitions

⚠️ Do not exclude a passage just because it sits inside a segment that's typically low-value by format (a recurring recommendations segment, merchandising, loose banter). Judge by CONTENT: if something inside that segment connects directly to the episode's core theme (see Summary), it's still eligible.

## Existing annotations
If the episode already has annotations, flag overlaps (threshold: 30 seconds) in the "overlap" field. Do not duplicate.

## Rules
- Base EVERYTHING exclusively on the provided transcript. Never invent or extrapolate
- Be selective: quality over quantity. A shallow or short episode may yield few suggestions (or none); a dense episode may yield many. Never pad the list to hit a count, and never hold back just to stay under an artificial ceiling.
- If the episode has unusual/original ideas (criterion 7), include them even if they are not the central topic. Do not fill the list only with the main, obvious beats — but also do not invent an unusual idea that is not in the transcript just to pad the list.
- When you hit a long conversational block (>60-90s) on the same topic, actively look for MORE THAN ONE quotable moment within it — different lines in the same block can satisfy different criteria (e.g. an impact statement, and minutes later on the same subject, a concrete data point). Don't collapse an entire topic block into a single suggestion just because you already covered the topic once
- Distribute suggestions proportionally across the FULL duration of the episode. When you reach the last quarter of the transcript, keep the same scrutiny as the beginning — coverage commonly drops off near the end
- The "description" field must be a short editorial explanation (1-2 sentences) of why this moment matters
- The "quote" field must contain a direct quote or faithful paraphrase from the transcript (1-2 sentences)
- The "criterion" field must indicate which criterion (1-8) the suggestion satisfies
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
