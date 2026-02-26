import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { requestHasImages } from "../types";
import type { Config } from "../config";
import { OpenRouterProvider } from "./openrouter";
import { OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { DeepSeekProvider } from "./deepseek";

// Providers that support image content parts
const VISION_CAPABLE_PROVIDERS = new Set(["openrouter", "openai", "anthropic", "ollama"]);

// Known reasoning models — use max_completion_tokens + reasoning params
const REASONING_MODELS = new Set([
  "deepseek-r1",
  "deepseek/deepseek-r1",
  "o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o4-mini",
]);

function isReasoningModel(model: string): boolean {
  // Check exact match and suffix match (e.g., "openrouter/deepseek/deepseek-r1")
  if (REASONING_MODELS.has(model)) return true;
  const lastSlash = model.lastIndexOf("/");
  if (lastSlash >= 0) {
    return REASONING_MODELS.has(model.substring(lastSlash + 1));
  }
  return false;
}

export interface ParsedModel {
  provider: "openrouter" | "ollama" | "openai" | "anthropic" | "deepseek";
  model: string; // model name to send to the provider API
}

/**
 * Parse a prefixed model string into provider + model name.
 *
 * Examples:
 *   "openrouter/openai/gpt-5.2" → { provider: "openrouter", model: "openai/gpt-5.2" }
 *   "ollama/geral"              → { provider: "ollama", model: "geral" }
 *   "openai/gpt-5.2"           → { provider: "openai", model: "gpt-5.2" }
 *   "anthropic/claude-opus-4.5" → { provider: "anthropic", model: "claude-opus-4.5" }
 *   "deepseek/deepseek-v3.2"   → { provider: "deepseek", model: "deepseek-chat" }
 */
export function parseModelString(modelStr: string): ParsedModel {
  const prefixes = ["openrouter/", "ollama/", "openai/", "anthropic/", "deepseek/"] as const;

  for (const prefix of prefixes) {
    if (modelStr.startsWith(prefix)) {
      const provider = prefix.slice(0, -1) as ParsedModel["provider"];
      const model = modelStr.substring(prefix.length);
      return { provider, model };
    }
  }

  // No prefix — treat as openrouter (default)
  return { provider: "openrouter", model: modelStr };
}

export class ProviderFactory {
  private providers: Map<string, AIProvider> = new Map();

  constructor(private config: Config) {
    if (config.openrouterApiKey) {
      this.providers.set("openrouter", new OpenRouterProvider(config.openrouterApiKey));
    }
    this.providers.set("ollama", new OllamaProvider(config.ollamaUrl));
    if (config.openaiApiKey) {
      this.providers.set("openai", new OpenAIProvider(config.openaiApiKey));
    }
    if (config.anthropicApiKey) {
      this.providers.set("anthropic", new AnthropicProvider(config.anthropicApiKey));
    }
    if (config.deepseekApiKey) {
      this.providers.set("deepseek", new DeepSeekProvider(config.deepseekApiKey));
    }
  }

  getProvider(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Execute a completion with fallback chain.
   *
   * Tries each model in sequence. Moves to next model on:
   * - Provider not configured
   * - API error
   * - Truncation (finish_reason=length)
   */
  async completeWithFallback(
    req: ChatCompletionRequest,
    modelChain: string[],
  ): Promise<ChatCompletionResponse> {
    const errors: string[] = [];

    for (const modelStr of modelChain) {
      const parsed = parseModelString(modelStr);
      const provider = this.getProvider(parsed.provider);

      if (!provider) {
        errors.push(`${modelStr}: provider "${parsed.provider}" not configured`);
        continue;
      }

      // Skip providers that don't support vision when request has images
      if (requestHasImages(req) && !VISION_CAPABLE_PROVIDERS.has(parsed.provider)) {
        console.log(`[vox-intelligence] ${modelStr}: skipping (provider "${parsed.provider}" does not support vision)`);
        errors.push(`${modelStr}: provider "${parsed.provider}" does not support vision`);
        continue;
      }

      try {
        const providerReq: ChatCompletionRequest = {
          ...req,
          model: parsed.model,
        };

        // Auto-detect reasoning models
        if (isReasoningModel(parsed.model) && !req.reasoning) {
          providerReq.reasoning = { effort: "none" };
        }

        console.log(`[vox-intelligence] Trying ${parsed.provider}/${parsed.model}...`);
        const result = await provider.complete(providerReq);

        if (result.finishReason === "length") {
          console.log(`[vox-intelligence] ${modelStr}: truncated (finish_reason=length), trying next model`);
          errors.push(`${modelStr}: truncated`);
          continue;
        }

        console.log(`[vox-intelligence] ${modelStr}: success (${result.usage?.promptTokens || "?"}/${result.usage?.completionTokens || "?"} tokens)`);
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[vox-intelligence] ${modelStr}: error — ${msg}`);
        errors.push(`${modelStr}: ${msg}`);
        continue;
      }
    }

    throw new Error(`All models failed:\n${errors.map(e => `  - ${e}`).join("\n")}`);
  }
}
