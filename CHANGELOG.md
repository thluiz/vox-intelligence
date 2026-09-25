# Changelog

All notable changes to vox-intelligence are documented in this file.

## [1.2.0] — 2026-09-25

### Uma língua só por nota

- **Novo teste 22 no ghost-audit, `IDIOMA_MISTO`** (severity `block`) — a nota mistura línguas (resumo em inglês e fichamento em português, heading "## Fichamento" numa nota em inglês). O `webclip-summary` com `gpt-5.4-mini` produziu 228 notas assim e a auditoria aprovava todas, porque nenhuma regra olhava a língua além do PT-EU
- **`webclip-summary`: a heading segue a língua da nota** — "## Fichamento" em português, "## Reading notes" em inglês. Antes era fixa em português, e o modelo escorregava para o português logo depois dela
- **`webclip-summary`: guarda determinística de língua** — compara resumo, fichamento, summary e heading com a língua do texto bruto (contagem de stopwords en/pt). Divergiu: uma reescrita; divergiu de novo: erro, a nota não volta
- **Fixture** — `red-idioma-misto.md`, nota real com resumo em inglês e fichamento em português

## [1.1.0] — 2026-09-10

### Ghost-audit: cabeçalho dramático e narração de processo

- **Novo teste 20, `CABECALHO_DRAMATICO`** (severity `warn`) — heading interno (`##`, `###`) do corpo que dramatiza, provoca ou promete em vez de nomear o que a seção contém ("O Enigma da Datação Ming", "Quando tudo muda"). O `title` do frontmatter já era coberto pelo item 19 do checklist da skill; o vão era o corpo, e ele importa em docs de pesquisa e verbetes de dicionário
- **Novo teste 21, `NARRACAO_DE_PROCESSO`** (severity `warn`) — a nota narra a própria busca ou sua falha ("não foi possível localizar", "as fontes consultadas não confirmam") em vez de omitir. Source-or-silence exige omissão na nota: o aviso de "não verificado" vai ao autor no chat, não ao leitor. Tique recorrente das skills `research` e `research-chinese-etymology`
- **Mesmas exceções do teste 12** no 21 — item marcado com ⚠ em doc de pesquisa é provisório-reconhecido, e seções de log de trabalho (fontes consultadas, em aberto, próximos passos) são registro do autor, não prosa para o leitor. Sem isso o teste 21 brigaria com a exceção (b) do SOURCE_OR_SILENCE
- **`mustExcludeRules` no `run-fixtures.ts`** — expectativa negada, para fixture que existe justamente para provar que uma regra NÃO dispara
- **Fixtures** — `yellow-cabecalho-dramatico.md`, `yellow-narracao-processo.md` e `green-research-warning-mark.md` (guarda contra o falso-positivo do 21 em doc de pesquisa)
- **Versão** — o `package.json` estava em 1.0.1 e o CHANGELOG parava em 0.5.2 (as versões de annotate não entraram aqui); ambos passam a 1.1.0

## [0.5.2] — 2026-07-19

### Ghost-audit: travessão de efeito em prosa vira block

- **`TRAVESSAO_DE_EFEITO` agora é severity `block`** (em prosa corrente) — travessão/traço/dois-pontos usado como pausa dramática ou inciso removível reprova a nota (`red`). Este autor não usa travessão de efeito; antes caía em `warn` e escapava para `yellow`
- **Abatimento de categoria restrito à estrutura de verbete** — o alívio de `TRAVESSAO_DE_EFEITO`/`PARALELISMO_MECANICO` em notas `category: etymology`/`disciple` vale só para glosas, acepções, tabelas de formas e fonologia. Prosa corrente (inclusive ensaio metodológico marcado `category: etymology`) recebe escrutínio completo. Corrige o vão em que uma nota-ensaio com `category: etymology` passava sem checagem de travessão (o `/style-test` também pula travessões nessas notas)
- **Carve-out explícito** — travessões em títulos de fonte (frontmatter), blocos de citação (`>`)/código reproduzindo marcador de verbete, e estrutura de ficha de caractere não são reportados
- **Fixtures** — nova `red-travessao-prose.md` (nota `category: etymology` em prosa com travessão → `red`); `yellow-voice.md` sem travessão (testa só os warns)

## [0.5.1] — 2026-07-15

### Suggest-annotations: atenção a ideias inusitadas + até 25 notas

- **Novo critério 7 (ideias inusitadas / fora do tradicional)** em `POST /presets/podcast/suggest-annotations` — reframings originais, imagens conceituais vívidas/metáforas, provocações contra-intuitivas e formulações idiossincráticas do orador. Mapeado no tier `reflection` (PT + EN)
- **Regra de reserva** — 2–4 sugestões deliberadamente reservadas às ideias mais originais do episódio, para não encher a lista só com os beats óbvios/centrais
- **Cap 8–20 → 8–25** sugestões
- **`temperature` 0.3 → 0.5** no suggest — afrouxa o viés pró-óbvio sem virar extrapolação

## [0.5.0] — 2026-07-13

### Presets Scholion: etymology-note e quote-note

- **`POST /presets/scholion/etymology-note`** — preset para o pipeline de radicais/etimologia de ideogramas. Default `gpt-5.4` (deepseek alucinava glosas/atribuições). Regras anti-fabricação do triage do source-audit: tons, cross-fonte, convergência, segmentação e IDs verbatim; atribuição por seção do dump (CUHK vs xiaoxue); sentinela 99999 do hanziyuan; sem inferência fonológica própria nas Divergências
- **`POST /presets/scholion/quote-note`** — síntese de nota de citação (Scholion), devolve **JSON estruturado** (só composição, sem markdown). **Modo livro** (detecta origem de livro e aperta o corpo). Com fonte fornecida, trata-a como A fonte (situar, não relitigar proveniência); proíbe frase-lixo de registros bibliográficos/edições no fecho e falsa atribuição ao contexto; garante fechamento `---` do frontmatter (build Hugo)
- **MCP** — `quote_note` exposto como tool MCP; registro dos MCP servers versionado (`.mcp.json`)
- **Deploy** — systemd unit versionada + docs de setup do host

## [0.4.0] — 2026-07-06

### Ghost-audit hardening

- **JSON repair round-trip** — invalid JSON from the model now triggers one repair call ("responda apenas o JSON corrigido") before failing with 502. Reduces silent fail-open releases at the commit gate
- **Quote location** — every finding gains a `line` field (1-based, computed server-side with whitespace-tolerant matching); `line: null` flags quotes not found in the note (possible hallucination)
- **`strict: true`** — runs the two preset models independently and unions their findings (dedupe by rule+quote); verdict recomputed from the union. For pre-publication audits where a false green costs more
- **Five new rules** synced from the ghost-writer checklist: `CENA_FABRICADA` (impersonal invented scenes), `REDUNDANCIA_POS_BOLD`, `CONDICIONAL_VERBOSA`, `ESCALA_TEMPORAL`, `CITACAO_VERBATIM_NAO_CONFIRMADA` (unconfirmed verbatim quotes from auto-transcription)
- **Category awareness** — `category: etymology|disciple` relaxes `TRAVESSAO_DE_EFEITO`/`PARALELISMO_MECANICO` over dictionary-gloss structure (matches /style-test behavior)
- **Regression fixtures** — `templates/quality/fixtures/` + `run-fixtures.ts`: known-red (source-or-silence), known-yellow (voice warns), known-green notes with expected verdicts/rules. Run after prompt edits or model swaps

## [0.3.0] — 2026-03-04

### Scholion integration

- **Holographic dialog preset** (`POST /presets/holographic-dialog`) — generates academic margin notes (scholia) for podcast episodes. Accepts episode JSON + user message + optional timestamp + optional existing dialog. Returns structured `{title, content}` JSON. Supports web search via Perplexity tool_use loop. Auto-detects Portuguese/English from episode language
- **Voice transcription** (`POST /transcribe`) — multipart form-data endpoint for audio-to-text. Primary model: `mistralai/voxtral-small-24b-2507` (native PT+EN). Fallback: `openai/gpt-4o-mini-transcribe`. Auto-detects format (m4a/mp4/webm/ogg/wav/mp3/flac). Returns `{transcript, model}`
- **Input size validation** — max 1,000,000 chars enforced on all preset endpoints. Returns HTTP 413 with estimated duration on oversized inputs

### Template improvements

- **Episode preset** — stricter extraction rules: participants must "actively speak" (not merely mentioned/quoted/referenced). Tags enforce lowercase ASCII kebab-case, no accents, max 10, ordered by relevance

### Core enhancements

- **Model chain resolution** (`resolveModelChain()`) — 3-tier priority system: user override (highest) → preset defaults (middle) → config global (lowest). Used consistently by all presets
- **Vision content types** — `ContentPart[]` union of `TextContentPart | ImageContentPart` with helpers `getTextContent()`, `hasImages()`, `requestHasImages()`

## [0.2.0] — 2026-02-27

### MCP integration

- **MCP server** (`POST /mcp`) — Streamable HTTP transport, JSON-RPC 2.0. Tools: `podcast_episode`, `podcast_annotate`, `vision_extract_bookmarks`, `chat`
- **CLAUDE.md** — operational docs for Claude Code agents: MCP tools, prompt caching best practices, model chain resolution, vision preset creation guide

## [0.1.0] — 2026-02-26

Initial release of vox-intelligence AI gateway.

### Architecture

- **TypeScript + Bun** — zero external dependencies, native .ts runtime
- **Strategy pattern** for AI providers — each implements `AIProvider` interface
- **OpenAI-compatible API** (`POST /v1/chat/completions`) with fallback chains via `x-fallback-models` header

### Providers

- **OpenRouter** — cloud aggregator with volume caching
- **Ollama** — local inference, zero cost fallback
- **OpenAI** — direct API access
- **Anthropic** — native Messages API with prompt caching
- **Deepseek** — direct API access

### Presets

- **Podcast episode** (`POST /presets/podcast-episode`) — structured extraction: summary, tags, timeline, recommendations, participants. Single LLM call replaces previous 3-call approach (~75% token savings)
- **Podcast annotate** (`POST /presets/podcast-annotate`) — bookmark timestamp annotations
- **Vision extract bookmarks** (`POST /presets/vision/extract-bookmarks`) — extract timestamps from screenshot images

### Infrastructure

- systemd service on port 8004 (HermesTools)
- nginx gateway via `/api/vox-intelligence/`
- Prompt caching: system message + fixed template prefix maximizes cache hits

