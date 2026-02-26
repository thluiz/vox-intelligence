import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { requestHasImages } from "../types";

export class DeepSeekProvider implements AIProvider {
  readonly name = "deepseek";
  private apiKey: string;
  private defaultTimeout: number;

  constructor(apiKey: string, defaultTimeout = 600_000) {
    this.apiKey = apiKey;
    this.defaultTimeout = defaultTimeout;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (requestHasImages(req)) {
      throw new Error("DeepSeek does not support image content");
    }

    if (!this.apiKey) {
      throw new Error("DeepSeek API key not configured");
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: Math.min(req.maxTokens, 8192),
    };

    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`DeepSeek ${res.status}: ${text}`);
      }

      const data = await res.json() as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`DeepSeek error: ${data.error.message}`);
      }

      const choice = data.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error("DeepSeek returned empty response");
      }

      // Log cache hit for visibility
      if (data.usage?.prompt_cache_hit_tokens) {
        console.log(`[vox-intelligence] DeepSeek cache hit: ${data.usage.prompt_cache_hit_tokens} tokens cached`);
      }

      return {
        content: choice.message.content,
        finishReason: choice.finish_reason === "length" ? "length" : "stop",
        model: data.model || req.model,
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
        } : undefined,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`DeepSeek timeout after ${this.defaultTimeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
