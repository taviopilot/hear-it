import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import { countWords } from "./extractor.js";
import type {
  AudioRenderResult,
  ExtractedArticle,
  SpeechOptions,
} from "./types.js";
import type { AudioStore } from "./storage.js";

const execFile = promisify(execFileCallback);
const OPENAI_API_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_TTS_TIMEOUT_MS = 30_000;
export const DEFAULT_TTS_INSTRUCTIONS = "Read this article aloud like a warm, conversational human podcast host, in a natural, engaging style, that is clear and easy to follow, with steady pace, with brief pauses at headings and sentence boundaries, with subtle emphasis on key ideas, that helps the listener track complex ideas, with clarity for technical and news writing.";
const FLITE_VOICE_BY_APP_VOICE: Record<string, string> = {
  alloy: "slt",
  ash: "kal",
  sage: "rms",
  verse: "awb",
};

export const AVAILABLE_VOICES = ["alloy", "ash", "sage", "verse"] as const;
export const VOICE_PREVIEW_TEXT =
  "This is Hear It. I turn articles into clear, natural audio you can listen to on the move.";

export class OpenAITTSTimeoutError extends Error {
  readonly code = "tts_timeout";

  constructor(
    readonly details: {
      timeoutMs: number;
      voice: string;
      textLength: number;
    },
  ) {
    super("OpenAI speech generation timed out.");
    this.name = "OpenAITTSTimeoutError";
  }
}

export interface SpeechSynthesisContext {
  audioStore?: AudioStore;
  /** Path-like key for the audio file, e.g. "voice-preview--alloy.mp3" */
  fileKey?: string;
}

export interface SpeechProvider {
  readonly name: string;
  synthesizeText(
    text: string,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult>;
  synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult>;
}

export interface SpeechProviderFactoryOptions {
  ttsProvider?: string | undefined;
  ffmpegSupportsFlite?: boolean | undefined;
}

export const DEFAULT_SPEECH_OPTIONS: SpeechOptions = {
  voice: "alloy",
};

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = "fake";

  async synthesizeText(
    text: string,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const audioData = Buffer.from("fake-audio");
    const durationSeconds = Math.max(15, Math.ceil(countWords(text) / 2.7));
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, audioData, "audio/mpeg")
        : null;

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds }] : [],
      durationSeconds,
      audioData,
      contentType: "audio/mpeg",
    };
  }

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }
}

export class FliteSpeechProvider implements SpeechProvider {
  readonly name = "flite";

  constructor(
    private readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  ) {}

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    text: string,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "hear-it-flite-"));
    const textPath = join(tempDir, "input.txt");

    try {
      await writeFile(textPath, text, "utf8");
      const voice = FLITE_VOICE_BY_APP_VOICE[speechOptions.voice] ?? FLITE_VOICE_BY_APP_VOICE.alloy;
      const { stdout } = await execFile(this.ffmpegPath, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `flite=textfile=${textPath}:voice=${voice}`,
        "-f",
        "mp3",
        "pipe:1",
      ], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      });

      const buffer = stdout instanceof Buffer ? stdout : Buffer.from(stdout);
      const audioUrl =
        context.audioStore && context.fileKey
          ? await context.audioStore.put(context.fileKey, buffer, "audio/mpeg")
          : null;
      const durationSeconds = estimateDurationSeconds(text);

      return {
        audioUrl,
        playlistUrl: null,
        audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds }] : [],
        durationSeconds,
        audioData: buffer,
        contentType: "audio/mpeg",
      };
    } catch (error) {
      throw new Error(
        `Local flite speech generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class OpenAISpeechProvider implements SpeechProvider {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_MODEL,
  ) {}

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    text: string,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const timeoutMs = Number(process.env.OPENAI_TTS_TIMEOUT_MS ?? DEFAULT_OPENAI_TTS_TIMEOUT_MS);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

    let response: Response;
    try {
      response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          voice: speechOptions.voice,
          input: text,
          instructions: DEFAULT_TTS_INSTRUCTIONS,
          response_format: "mp3",
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OpenAITTSTimeoutError({
          timeoutMs,
          voice: speechOptions.voice,
          textLength: text.length,
        });
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json() as { error?: { message?: string; code?: string; type?: string } };
        detail = body.error?.message ?? JSON.stringify(body);
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new Error(
        `OpenAI speech generation failed: ${response.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, buffer, "audio/mpeg")
        : null;

    const durationSeconds = estimateDurationSeconds(text);

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds }] : [],
      durationSeconds,
      audioData: buffer,
      contentType: "audio/mpeg",
    };
  }
}

export function ffmpegSupportsFlite(ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg"): boolean {
  try {
    const probe = spawnSync(ffmpegPath, ["-filters"], { encoding: "utf8", timeout: 5_000 });
    return probe.status === 0 && (probe.stdout?.includes(" flite ") ?? false);
  } catch {
    return false;
  }
}

export function createSpeechProvider(options: SpeechProviderFactoryOptions = {}): SpeechProvider {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const providerPreference = options.ttsProvider ?? process.env.TTS_PROVIDER ?? "auto";
  const fliteAvailable = options.ffmpegSupportsFlite ?? ffmpegSupportsFlite();

  if (providerPreference === "openai") {
    if (!apiKey) {
      throw new Error("TTS_PROVIDER=openai requires OPENAI_API_KEY.");
    }
    return new OpenAISpeechProvider(apiKey);
  }

  if (providerPreference === "flite") {
    if (!fliteAvailable) {
      throw new Error("TTS_PROVIDER=flite requires ffmpeg with the flite filter enabled.");
    }
    return new FliteSpeechProvider();
  }

  if (providerPreference === "fake") {
    return new FakeSpeechProvider();
  }

  if (apiKey) {
    return new OpenAISpeechProvider(apiKey);
  }

  if (fliteAvailable) {
    return new FliteSpeechProvider();
  }

  return new FakeSpeechProvider();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function estimateDurationSeconds(text: string): number {
  return Math.max(1, Math.ceil(countWords(text) / 2.7));
}

export function buildAudioFileKey(
  titleOrUrl: string,
  voice: string,
  uniqueSuffix?: string,
): string {
  const base = `${slugify(titleOrUrl)}--${voice}`;
  const stem = uniqueSuffix ? `${base}--${slugify(uniqueSuffix)}` : base;
  return `${stem}.mp3`;
}
