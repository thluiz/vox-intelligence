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

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private apiKey: string;
  private defaultTimeout: number;

  constructor(apiKey: string, defaultTimeout = 600_000) {
    this.apiKey = apiKey;
    this.defaultTimeout = defaultTimeout;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    const isReasoning = req.reasoning !== undefined;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: formatMessages(req.messages),
    };

    if (isReasoning) {
      body.max_completion_tokens = req.maxTokens;
      body.reasoning = req.reasoning;
    } else {
      body.max_tokens = req.maxTokens;
      if (req.temperature !== undefined) {
        body.temperature = req.temperature;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
        throw new Error(`OpenAI ${res.status}: ${text}`);
      }

      const data = await res.json() as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`OpenAI error: ${data.error.message}`);
      }

      const choice = data.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error("OpenAI returned empty response");
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
        throw new Error(`OpenAI timeout after ${this.defaultTimeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
