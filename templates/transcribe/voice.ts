/**
 * voice.ts — Voice transcription preset for vox-intelligence
 *
 * Accepts an audio buffer and transcribes via OpenRouter.
 * Primary: mistralai/voxtral-small-24b-2507 (auto language detect, PT+EN native)
 * Fallback: openai/gpt-4o-mini-transcribe
 */

import type { Config } from "../../config";

export interface VoiceTranscribeResult {
  transcript: string;
  model: string;
}

const TRANSCRIBE_MODELS = [
  "openai/gpt-audio-mini",
  "google/gemini-3.1-flash-lite-preview",
];

function extToFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "webm";
  const map: Record<string, string> = {
    m4a: "mp4",
    mp4: "mp4",
    webm: "webm",
    ogg: "ogg",
    wav: "wav",
    mp3: "mp3",
    flac: "flac",
  };
  return map[ext] || "webm";
}

export async function handleVoiceTranscribe(
  buffer: ArrayBuffer,
  filename: string,
  config: Config,
): Promise<VoiceTranscribeResult> {
  if (!config.openrouterApiKey) {
    throw new Error("OpenRouter API key not configured");
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const format = extToFormat(filename);

  let lastError: Error | null = null;

  for (const model of TRANSCRIBE_MODELS) {
    try {
      console.log(`[transcribe] Trying ${model} (format: ${format}, size: ${(buffer.byteLength / 1024).toFixed(0)}KB)`);

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openrouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://scholion.hermes-pt",
          "X-Title": "Scholion Voice Transcription",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { data: base64, format },
                },
                {
                  type: "text",
                  text: "Transcribe this audio exactly as spoken. Return only the transcription text, no additional commentary or labels.",
                },
              ],
            },
          ],
          max_tokens: 4096,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter ${model} (${res.status}): ${text.slice(0, 300)}`);
      }

      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const transcript = data.choices?.[0]?.message?.content?.trim() || "";
      if (!transcript) throw new Error("Empty transcript response");

      console.log(`[transcribe] Success with ${model}: ${transcript.slice(0, 80)}...`);
      return { transcript, model };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[transcribe] ${model} failed:`, lastError.message);
    }
  }

  throw lastError || new Error("All transcription models failed");
}
