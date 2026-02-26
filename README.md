# vox-intelligence

Generic AI gateway with a strategy pattern for providers. Exposes an **OpenAI-compatible REST API** that any service or script can consume, with built-in fallback chains and provider routing.

## Why

The podcast pipeline (and future pipelines) require LLM calls through different providers (OpenRouter, OpenAI, Anthropic, Ollama). Instead of each script duplicating HTTP calls, fallback logic, parsing, and retry — vox-intelligence centralizes all of this as a single API.

**Scope**: exclusively AI calls. Download, transcription, markdown assembly, and publishing remain in separate services.

## Cost Efficiency as Architecture

- **Direct provider routing** — `openai/gpt-5.2` calls OpenAI directly (no intermediary markup); `openrouter/openai/gpt-5.2` routes via OpenRouter when volume caching benefits apply
- **Prompt caching** — system message + fixed template prefix stays identical across calls, maximizing cache hits on Anthropic and OpenAI
- **Local fallback** — `ollama/geral` as fallback = zero cost for non-critical processing
- **Presets consolidate calls** — podcast pipeline went from 3 separate LLM calls to 1 (summary + tags + timeline + recommendations in one shot), saving ~75% on input tokens

## Stack

- **TypeScript + Bun** — zero external dependencies, native `.ts` runtime
- **Strategy pattern** — each provider implements `AIProvider` interface; adding a new provider = one file
- No build step, no bundler — Bun runs `.ts` natively

## Architecture

```
server.ts                  # Bun.serve() port 8004 — HTTP router
config.ts                  # .env loading, defaults
types.ts                   # Interfaces, model chain resolution, vision content types

providers/
  provider.ts              # AIProvider interface + factory + fallback chain
  openrouter.ts            # OpenRouter (cloud aggregator)
  ollama.ts                # Ollama local (OpenAI-compatible)
  openai.ts                # OpenAI direct
  anthropic.ts             # Anthropic direct (Messages API conversion)
  deepseek.ts              # Deepseek direct

templates/
  podcasts/
    episode.ts             # Preset: structured episode parsing (summary + tags + timeline + recommendations)
    annotate.ts            # Preset: bookmark annotations
  vision/
    extract-bookmarks.ts   # Preset: extract timestamps from screenshots
  dialog/
    holographic.ts         # Preset: Scholion academic margin notes
  transcribe/
    voice.ts               # Preset: audio-to-text transcription
```

## Providers

| Provider | Endpoint | Auth | Use Case |
|----------|----------|------|----------|
| **OpenRouter** | `openrouter.ai/api/v1/chat/completions` | Bearer token | Cloud aggregator, volume caching |
| **Ollama** | `localhost:11434/v1/chat/completions` | None | Local, zero cost, offline fallback |
| **OpenAI** | `api.openai.com/v1/chat/completions` | Bearer token | Direct, no intermediary overhead |
| **Anthropic** | `api.anthropic.com/v1/messages` | x-api-key | Native prompt caching, direct |
| **Deepseek** | `api.deepseek.com/v1/chat/completions` | Bearer token | Direct API |

Model prefix determines the provider: `openrouter/`, `ollama/`, `openai/`, `anthropic/`, `deepseek/`. No prefix defaults to OpenRouter.

## Model Chain Resolution

Three-tier priority system for selecting models:

1. **User override** (highest) — model specified in request body
2. **Preset defaults** (middle) — model defined in template
3. **Config global** (lowest) — `DEFAULT_MODELS` from `.env`

Fallback chains try models in sequence; moves to next on error or truncation.

## Endpoints

### Core API

| Endpoint | Auth | Method | Description |
|----------|------|--------|-------------|
| `/health` | No | GET | Status + configured providers |
| `/v1/chat/completions` | No | POST | OpenAI-compatible completion with fallback chain |

### Presets

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/presets/podcast/episode` | POST | Structured episode parsing (summary, tags, timeline, recommendations, participants) |
| `/presets/podcast/annotate` | POST | Bookmark timestamp annotations |
| `/presets/vision/extract-bookmarks` | POST | Extract timestamps from screenshot images |
| `/presets/holographic-dialog` | POST | Scholion academic margin notes |
| `/transcribe` | POST | Voice-to-text (multipart form-data) |

### MCP

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC 2.0 (Streamable HTTP) |
| `/mcp` | GET | SSE keep-alive |

**MCP Tools**: `podcast_episode`, `podcast_annotate`, `vision_extract_bookmarks`, `chat`

## Limits

**Maximum input size: 1,000,000 characters** (~12.5 hours of audio). Requests exceeding this are rejected with HTTP 413. Falling back to smaller models would waste money and produce hallucinations — failing fast is the correct behavior.

## Configuration

```env
PORT=8004
OPENROUTER_API_KEY=sk-or-v1-...
OLLAMA_URL=http://localhost:11434
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
DEFAULT_MODELS=deepseek/deepseek-chat,openrouter/openai/gpt-5.2,ollama/geral
MAX_OUTPUT_TOKENS=16000
```

## Running

```bash
# Via systemd (production)
sudo systemctl start vox-intelligence

# Manually
bun run server.ts

# Verify
curl http://localhost:8080/api/vox-intelligence/health
```

## Adding a New Provider

1. Create `providers/newprovider.ts` implementing `AIProvider`
2. Register in `ProviderFactory` constructor (`providers/provider.ts`)
3. Add prefix handling in `parseModelString()`

## Adding a New Preset

1. Create `templates/category/preset.ts` with system prompt + user prompt builder + response parser
2. Add route in `server.ts`
