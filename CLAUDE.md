# vox-intelligence — Agent Instructions

## Security

- NEVER include real tokens, API keys, or credentials in any committed file
- All secrets go in `.env` (which is in `.gitignore`)
- `.env.example` must only contain fake placeholder values

## MCP Server

vox-intelligence exposes an MCP server at `POST /mcp` (Streamable HTTP transport).

### Endpoints

| Path | Description |
|------|-------------|
| `POST /mcp` | MCP JSON-RPC 2.0 (single or batch requests) |
| `GET /mcp` | SSE keep-alive (minimal, for clients that need it) |
| `POST /v1/chat/completions` | OpenAI-compatible chat API |
| `POST /presets/podcast/episode` | Podcast episode preset (HTTP direct) |
| `POST /presets/podcast/annotate` | Podcast annotate preset (HTTP direct) |
| `POST /presets/vision/extract-bookmarks` | Vision preset (HTTP direct) |
| `POST /presets/scholion/ghost-audit` | Ghost-writer voice audit for Scholion notes (HTTP direct). Body: `{content, slug?, strict?}`. Regression eval: `bun templates/quality/run-fixtures.ts` |

### MCP Tools

| Tool | Description |
|------|-------------|
| `podcast_episode` | Process transcript + metadata → structured Vox note |
| `podcast_annotate` | Annotate bookmarks with transcript context |
| `vision_extract_bookmarks` | Extract timestamps from screenshot images |
| `chat` | Generic gateway call with multi-provider fallback |

### Registration

- **OpenClaw** (ClaudinhoSandbox): `http://localhost:8004/mcp` (direct, registered in `~/.openclaw/openclaw.json`)
- **Claude Code** (Windows host): `http://localhost:8080/mcp` (via nginx, registered in `~/.claude/claude.json`)

### Usage Examples

```bash
# Initialize (handshake)
curl -s -X POST http://localhost:8004/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1"}}}'

# List tools
curl -s -X POST http://localhost:8004/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call podcast_episode tool
curl -s -X POST http://localhost:8004/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{
      "name":"podcast_episode",
      "arguments":{
        "metadata":{"title":"Exemplo","podcast":"Meu Podcast","published":"2026-02-27"},
        "transcript":"[00:00:00] Host: Bem-vindos ao episódio...",
        "model":"openrouter/deepseek/deepseek-v3.2"
      }
    }
  }'

# Call chat tool (use local Ollama)
curl -s -X POST http://localhost:8004/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params":{
      "name":"chat",
      "arguments":{
        "model":"ollama/geral",
        "messages":[{"role":"user","content":"Olá, tudo bem?"}]
      }
    }
  }'

# Call vision_extract_bookmarks tool
curl -s -X POST http://localhost:8004/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":5,"method":"tools/call",
    "params":{
      "name":"vision_extract_bookmarks",
      "arguments":{
        "images":["<base64-encoded-screenshot>"]
      }
    }
  }'
```

### Adding New MCP Tools

1. Implement the logic in a template file or directly in `mcp.ts`
2. Add entry to the `TOOLS` array in `mcp.ts` with proper JSON Schema `inputSchema`
3. Add the dispatch case in the `"tools/call"` handler in `mcp.ts`
4. No restart needed if using `bun --watch` (development). Otherwise `systemctl restart vox-intelligence`

---

## Prompt Caching

When building prompts for LLM calls, keep the beginning of the prompt identical across calls:
1. System message first (stable, cacheable)
2. Fixed template text (stable, cacheable)
3. Variable content last (transcript, metadata)

This enables prompt caching on providers (Anthropic, OpenAI) and reduces token cost.

## Architecture

- Each provider implements the `AIProvider` interface (`types.ts`)
- Provider selection is via model prefix: `openrouter/`, `ollama/`, `openai/`, `anthropic/`, `deepseek/`
- Fallback chain: tries models in sequence; moves to next on error or truncation
- Presets (`templates/`) are sugar — they build prompts, call the core, and parse responses
- `mcp.ts` exposes all presets as MCP tools (Streamable HTTP transport)
- No streaming, no tool calling, no audio — this is a batch processing gateway

### Model Chain Resolution (3-tier)

`resolveModelChain()` in `types.ts` — all presets MUST use this helper:

```
user request (model + fallbackModels)  →  preset defaults  →  config.defaultModels
```

1. **User override** (highest priority): if the API request includes `model` or `fallbackModels`, use those exclusively
2. **Preset defaults**: a `const DEFAULT_*_MODELS` array defined in the preset file — optional, each preset can define its own chain tuned to its task
3. **Config global** (lowest): `config.defaultModels` from env var `DEFAULT_MODELS`

Usage in a preset:
```typescript
import { resolveModelChain } from "../../types";

// Preset with its own defaults:
const DEFAULT_VISION_MODELS = ["openrouter/google/gemini-2.5-flash-lite", ...];
const modelChain = resolveModelChain(req.model, req.fallbackModels, DEFAULT_VISION_MODELS, config.defaultModels);

// Preset without own defaults (falls through to global):
const modelChain = resolveModelChain(req.model, req.fallbackModels, undefined, config.defaultModels);
```

### Vision Support

- `types.ts` defines `ContentPart` (union of `TextContentPart | ImageContentPart`) — `ChatMessage.content` accepts `string | ContentPart[]`
- Providers that support images: `openrouter`, `openai`, `anthropic`, `ollama` (set `VISION_CAPABLE_PROVIDERS` in `providers/provider.ts`)
- `completeWithFallback()` auto-skips non-vision providers when request has images
- `deepseek` provider throws on images (caught by fallback chain)
- Helpers: `getTextContent(msg)`, `hasImages(msg)`, `requestHasImages(req)`

#### Creating a new vision preset

1. Create `templates/vision/<name>.ts`
2. Define a `DEFAULT_*_MODELS` array with vision-capable models (prefer cheap: `gemini-2.5-flash-lite` → `gpt-4o-mini`)
3. Build messages with `ContentPart[]` for images: `{ type: "image", mediaType: "image/jpeg", data: "<base64>" }`
4. Use `resolveModelChain()` for the model chain
5. Add route in `server.ts` under `POST /presets/vision/<name>`
6. Existing reference: `templates/vision/extract-bookmarks.ts`

## Stack

- Runtime: Bun (runs .ts natively)
- Port: 8004
- No external dependencies (uses Bun built-ins)
- Service: `systemctl restart vox-intelligence` (system-level, managed by root)
