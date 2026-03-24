import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAISpeechProvider, OpenAITTSTimeoutError, createSpeechProvider } from "./tts.js";

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.OPENAI_TTS_TIMEOUT_MS;
const originalProvider = process.env.TTS_PROVIDER;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalFfmpegBinary = process.env.FFMPEG_BINARY;

describe("openai speech provider", () => {
  it("times out stalled OpenAI synthesis requests", async () => {
    process.env.OPENAI_TTS_TIMEOUT_MS = "10";
    globalThis.fetch = vi.fn((_input, init) => new Promise((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    const provider = new OpenAISpeechProvider("test-api-key");

    await expect(
      provider.synthesizeText(
        "This request should time out.",
        { voice: "ash" },
        {},
      ),
    ).rejects.toBeInstanceOf(OpenAITTSTimeoutError);
  });
});

describe("speech provider selection", () => {
  it("falls back to fake when local is requested but ffmpeg is unavailable", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.TTS_PROVIDER = "local";
    process.env.FFMPEG_BINARY = "/definitely-missing-ffmpeg";

    const provider = createSpeechProvider();
    expect(provider.name).toBe("fake");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalTimeout === undefined) {
    delete process.env.OPENAI_TTS_TIMEOUT_MS;
  } else {
    process.env.OPENAI_TTS_TIMEOUT_MS = originalTimeout;
  }

  if (originalProvider === undefined) {
    delete process.env.TTS_PROVIDER;
  } else {
    process.env.TTS_PROVIDER = originalProvider;
  }

  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }

  if (originalFfmpegBinary === undefined) {
    delete process.env.FFMPEG_BINARY;
  } else {
    process.env.FFMPEG_BINARY = originalFfmpegBinary;
  }
});
