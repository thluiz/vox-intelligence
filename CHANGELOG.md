# Changelog

All notable changes to vox-intelligence are documented in this file.

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
