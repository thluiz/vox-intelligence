// Configuration loaded from environment variables

export interface Config {
  port: number;
  openrouterApiKey: string;
  ollamaUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  deepseekApiKey: string;
  defaultModels: string[];
  maxOutputTokens: number;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "8004", 10),
    openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
    defaultModels: (process.env.DEFAULT_MODELS || "openrouter/openai/gpt-5.2,openrouter/anthropic/claude-opus-4.5,openrouter/deepseek/deepseek-v3.2")
      .split(",")
      .map(m => m.trim())
      .filter(Boolean),
    maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || "16000", 10),
  };
}
