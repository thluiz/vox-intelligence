import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ContentPart } from "../types";
import { getTextContent } from "../types";

function formatAnthropicContent(content: string | ContentPart[]): string | unknown[] {
  if (typeof content === "string") return content;
  return content.map((p: ContentPart) => {
    if (p.type === "text") return { type: "text", text: p.text };
    return {
      type: "image",
      source: { type: "base64", media_type: p.mediaType, data: p.data },
    };
  });
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private apiKey: string;
  private defaultTimeout: number;

  constructor(apiKey: string, defaultTimeout = 600_000) {
    this.apiKey = apiKey;
    this.defaultTimeout = defaultTimeout;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!this.apiKey) {
      throw new Error("Anthropic API key not configured");
    }

    // Convert OpenAI-style messages to Anthropic Messages API format:
    // - Extract system message separately (always text)
    // - Remaining messages go into the messages array (may include images)
    let system: string | undefined;
    const messages: { role: "user" | "assistant"; content: string | unknown[] }[] = [];

    for (const msg of req.messages) {
      if (msg.role === "system") {
        const text = getTextContent(msg);
        system = system ? `${system}\n\n${text}` : text;
      } else {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: formatAnthropicContent(msg.content),
        });
      }
    }

    if (messages.length === 0) {
      throw new Error("Anthropic requires at least one user/assistant message");
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
    };

    if (system) {
      body.system = system;
    }

    if (req.temperature !== undefined && !req.reasoning) {
      body.temperature = req.temperature;
    }

    // Anthropic extended thinking maps from reasoning.effort
    if (req.reasoning) {
      body.thinking = {
        type: "enabled",
        budget_tokens: Math.min(req.maxTokens * 2, 32000),
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Anthropic ${res.status}: ${text}`);
      }

      const data = await res.json() as {
        content?: { type: string; text?: string }[];
        model?: string;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`Anthropic error: ${data.error.message}`);
      }

      // Extract text from content blocks (skip thinking blocks)
      const textBlocks = data.content?.filter(b => b.type === "text") || [];
      const content = textBlocks.map(b => b.text || "").join("\n");

      if (!content) {
        throw new Error("Anthropic returned empty response");
      }

      // Map Anthropic stop_reason to OpenAI finish_reason
      let finishReason: "stop" | "length" | "error" = "stop";
      if (data.stop_reason === "max_tokens") {
        finishReason = "length";
      }

      return {
        content,
        finishReason,
        model: data.model || req.model,
        usage: data.usage ? {
          promptTokens: data.usage.input_tokens || 0,
          completionTokens: data.usage.output_tokens || 0,
        } : undefined,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Anthropic timeout after ${this.defaultTimeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
