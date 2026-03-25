import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpeechProvider,
  FakeSpeechProvider,
  FliteSpeechProvider,
  OpenAISpeechProvider,
  OpenAITTSTimeoutError,
} from "./tts.js";

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.OPENAI_TTS_TIMEOUT_MS;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalTtsProvider = process.env.TTS_PROVIDER;

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

describe("speech provider factory", () => {
  it("prefers OpenAI when a key is available", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.TTS_PROVIDER;

    const provider = createSpeechProvider({ ffmpegSupportsFlite: true });

    expect(provider).toBeInstanceOf(OpenAISpeechProvider);
  });

  it("uses local flite automatically when OpenAI is unavailable", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.TTS_PROVIDER;

    const provider = createSpeechProvider({ ffmpegSupportsFlite: true });

    expect(provider).toBeInstanceOf(FliteSpeechProvider);
  });

  it("falls back to fake audio when neither OpenAI nor flite is available", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.TTS_PROVIDER;

    const provider = createSpeechProvider({ ffmpegSupportsFlite: false });

    expect(provider).toBeInstanceOf(FakeSpeechProvider);
  });

  it("honors explicit fake provider selection", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.TTS_PROVIDER = "fake";

    const provider = createSpeechProvider({ ffmpegSupportsFlite: true });

    expect(provider).toBeInstanceOf(FakeSpeechProvider);
  });

  it("fails fast when flite is forced but ffmpeg support is missing", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.TTS_PROVIDER = "flite";

    expect(() => createSpeechProvider({ ffmpegSupportsFlite: false })).toThrow(
      "TTS_PROVIDER=flite requires ffmpeg with the flite filter enabled.",
    );
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalTimeout === undefined) {
    delete process.env.OPENAI_TTS_TIMEOUT_MS;
  } else {
    process.env.OPENAI_TTS_TIMEOUT_MS = originalTimeout;
  }

  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }

  if (originalTtsProvider === undefined) {
    delete process.env.TTS_PROVIDER;
  } else {
    process.env.TTS_PROVIDER = originalTtsProvider;
  }
});
