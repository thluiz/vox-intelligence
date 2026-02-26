import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ContentPart } from "../types";

function formatMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }
    const parts = msg.content.map((p: ContentPart) => {
      if (p.type === "text") return { type: "text", text: p.text };
      return {
        type: "image_url",
        image_url: { url: `data:${p.mediaType};base64,${p.data}` },
      };
    });
    return { role: msg.role, content: parts };
  });
}

export class OllamaProvider implements AIProvider {
  readonly name = "ollama";
  private baseUrl: string;
  private defaultTimeout: number;

  constructor(baseUrl: string, defaultTimeout = 900_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.defaultTimeout = defaultTimeout;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: formatMessages(req.messages),
      stream: false,
    };

    // Ollama's OpenAI-compatible endpoint supports max_tokens
    if (req.maxTokens) {
      body.max_tokens = req.maxTokens;
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Ollama ${res.status}: ${text}`);
      }

      const data = await res.json() as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = data.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error("Ollama returned empty response");
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
        throw new Error(`Ollama timeout after ${this.defaultTimeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
