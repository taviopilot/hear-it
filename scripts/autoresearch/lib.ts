import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const TTS_FILE = path.join(REPO_ROOT, "apps/api/src/tts.ts");
export const RESULTS_FILE = path.join(__dirname, "results.tsv");
const CACHE_FILE = path.join(__dirname, "cache.json");
const RESULTS_HEADER = [
  "experiment_id",
  "timestamp",
  "judge_mode",
  "composite_score",
  "naturalness",
  "pacing",
  "engagement",
  "clarity",
  "prompt_hash",
  "instructions_preview",
  "benchmark_scores",
].join("\t") + "\n";

export const BENCHMARK_SNIPPETS = [
  {
    id: "technical",
    label: "Technical / science article",
    text: "The transformer architecture, introduced in 2017, revolutionized natural language processing. At its core, transformers use a self-attention mechanism that weighs the relevance of every token against every other token in a sequence simultaneously. This parallelism made transformers dramatically faster to train on modern GPUs, but the quadratic memory cost of full self-attention remains a challenge for long contexts.",
    traits: ["technical", "complex", "terms", "acronyms", "numbers"],
  },
  {
    id: "news",
    label: "Breaking news article",
    text: "Scientists announced a significant breakthrough in battery technology this week, claiming their new lithium-sulfur cells can store up to five times the energy of conventional lithium-ion batteries. Independent experts called the results promising, but warned that manufacturing cost and long-term durability remain open questions.",
    traits: ["news", "facts", "quotes", "urgency", "balance"],
  },
  {
    id: "narrative",
    label: "Longform narrative / opinion",
    text: "Walking through the old quarter at dusk, she noticed how the fading light transformed the familiar into something almost luminous. She had lived here for eleven years, but only now, on the brink of leaving, did the neighborhood feel fully hers. There is a particular tenderness reserved for things you are about to lose.",
    traits: ["narrative", "imagery", "emotion", "reflection"],
  },
  {
    id: "analysis",
    label: "Explainer with lists and transitions",
    text: "There are three reasons the policy matters. First, it changes how local governments fund new housing. Second, it shifts risk from developers to lenders. Third, it could make already expensive projects even harder to complete. Supporters say the trade-off is worth it; critics say the transition costs have been understated.",
    traits: ["lists", "transitions", "contrast", "enumeration"],
  },
] as const;

export type JudgeMode = "heuristic" | "anthropic";

export interface DimensionScores {
  naturalness: number;
  pacing: number;
  engagement: number;
  clarity: number;
}

export interface SnippetEvaluation {
  snippetId: string;
  label: string;
  scores: DimensionScores;
  average: number;
}

export interface ExperimentResult {
  judgeMode: JudgeMode;
  instructions: string;
  preview: string;
  promptHash: string;
  evaluations: SnippetEvaluation[];
  dimensions: DimensionScores;
  composite: number;
}

export function extractCurrentInstructions(ttsFile = TTS_FILE): string {
  const source = fs.readFileSync(ttsFile, "utf8");
  const match =
    source.match(/const DEFAULT_TTS_INSTRUCTIONS\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s) ??
    source.match(/const DEFAULT_TTS_INSTRUCTIONS\s*=\s*`([^`]*)`/s);

  if (!match) {
    throw new Error(`Could not find DEFAULT_TTS_INSTRUCTIONS in ${ttsFile}`);
  }

  return match[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
}

export async function evaluateInstructions(
  instructions: string,
  requestedJudge = process.env.AUTORESEARCH_JUDGE || "auto",
): Promise<ExperimentResult> {
  const judgeMode = resolveJudgeMode(requestedJudge);
  const promptHash = hashText(instructions);
  const cache = loadCache();
  const evaluations: SnippetEvaluation[] = [];

  for (const snippet of BENCHMARK_SNIPPETS) {
    const cacheKey = `${judgeMode}:${promptHash}:${snippet.id}`;
    const cached = cache[cacheKey] as SnippetEvaluation | undefined;
    if (cached) {
      evaluations.push(cached);
      continue;
    }

    const evaluation = judgeMode === "anthropic"
      ? await evaluateAnthropicSnippet(instructions, snippet)
      : evaluateHeuristicSnippet(instructions, snippet);
    cache[cacheKey] = evaluation;
    evaluations.push(evaluation);
  }

  saveCache(cache);

  const dimensions = averageDimensions(evaluations);
  const composite = average([
    dimensions.naturalness,
    dimensions.pacing,
    dimensions.engagement,
    dimensions.clarity,
  ]);

  return {
    judgeMode,
    instructions,
    preview: previewInstructions(instructions),
    promptHash,
    evaluations,
    dimensions,
    composite: round2(composite),
  };
}

export function appendResult(result: ExperimentResult): void {
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, RESULTS_HEADER);
  }

  const experimentId = `${Date.now()}-${result.promptHash.slice(0, 6)}`;
  const timestamp = new Date().toISOString();
  const row = [
    experimentId,
    timestamp,
    result.judgeMode,
    result.composite.toFixed(2),
    result.dimensions.naturalness.toFixed(2),
    result.dimensions.pacing.toFixed(2),
    result.dimensions.engagement.toFixed(2),
    result.dimensions.clarity.toFixed(2),
    result.promptHash,
    sanitize(result.preview),
    sanitize(JSON.stringify(result.evaluations.map((evaluation) => ({
      snippetId: evaluation.snippetId,
      average: evaluation.average,
      scores: evaluation.scores,
    })))),
  ].join("\t") + "\n";

  fs.appendFileSync(RESULTS_FILE, row);
}

export function formatSummary(result: ExperimentResult): string {
  const lines = [
    `${result.judgeMode} composite: ${result.composite.toFixed(2)} / 10`,
    `dimensions: naturalness=${result.dimensions.naturalness.toFixed(2)} pacing=${result.dimensions.pacing.toFixed(2)} engagement=${result.dimensions.engagement.toFixed(2)} clarity=${result.dimensions.clarity.toFixed(2)}`,
  ];

  for (const evaluation of result.evaluations) {
    lines.push(
      `  [${evaluation.snippetId}] ${evaluation.average.toFixed(2)} ` +
        `(nat=${evaluation.scores.naturalness.toFixed(2)} pac=${evaluation.scores.pacing.toFixed(2)} eng=${evaluation.scores.engagement.toFixed(2)} cla=${evaluation.scores.clarity.toFixed(2)})`,
    );
  }

  return lines.join("\n");
}

function resolveJudgeMode(requested: string): JudgeMode {
  const normalized = requested.trim().toLowerCase();
  if (normalized === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error("ANTHROPIC_API_KEY is required for AUTORESEARCH_JUDGE=anthropic");
    }
    return "anthropic";
  }

  if (normalized === "auto") {
    return process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "heuristic";
  }

  return "heuristic";
}

function evaluateHeuristicSnippet(
  instructions: string,
  snippet: (typeof BENCHMARK_SNIPPETS)[number],
): SnippetEvaluation {
  const lower = instructions.toLowerCase();
  const wordCount = instructions.split(/\s+/).filter(Boolean).length;
  const sentenceCount = instructions.split(/[.!?]+/).filter((value) => value.trim().length > 0).length;

  let naturalness = 5.8;
  naturalness += keywordBonus(lower, ["warm", "conversational", "natural", "calm", "clear"], 0.45);
  naturalness += keywordBonus(lower, ["robotic", "flat", "theatrical"], 0.25);
  naturalness += rangeBonus(wordCount, 18, 55, 0.5);
  naturalness += rangeBonus(sentenceCount, 2, 4, 0.3);

  let pacing = 5.6;
  pacing += keywordBonus(lower, ["steady", "pacing", "pause", "sentence boundaries", "headings"], 0.55);
  pacing += keywordBonus(lower, ["rush", "dense passages", "lists", "quotes", "numbers"], 0.35);
  if (snippet.traits.includes("lists")) pacing += keywordBonus(lower, ["lists", "transitions", "numbers"], 0.45);
  if (snippet.traits.includes("technical")) pacing += keywordBonus(lower, ["dense", "technical", "terms"], 0.3);

  let engagement = 5.4;
  engagement += keywordBonus(lower, ["engaging", "listener", "subtle emphasis", "warm", "narrator"], 0.45);
  if (snippet.traits.includes("narrative")) engagement += keywordBonus(lower, ["story", "reflective", "calm", "warm"], 0.35);
  if (snippet.traits.includes("news")) engagement += keywordBonus(lower, ["clear", "measured", "balanced"], 0.25);

  let clarity = 5.7;
  clarity += keywordBonus(lower, ["clear", "key ideas", "names", "transitions", "sentence boundaries"], 0.5);
  clarity += keywordBonus(lower, ["numbers", "quotes", "lists", "headings"], 0.3);
  if (snippet.traits.includes("technical")) clarity += keywordBonus(lower, ["terms", "numbers", "never rush"], 0.45);

  const scores: DimensionScores = {
    naturalness: clamp(round2(naturalness), 1, 10),
    pacing: clamp(round2(pacing), 1, 10),
    engagement: clamp(round2(engagement), 1, 10),
    clarity: clamp(round2(clarity), 1, 10),
  };

  return {
    snippetId: snippet.id,
    label: snippet.label,
    scores,
    average: round2(average(Object.values(scores))),
  };
}

async function evaluateAnthropicSnippet(
  instructions: string,
  snippet: (typeof BENCHMARK_SNIPPETS)[number],
): Promise<SnippetEvaluation> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!.trim(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.AUTORESEARCH_ANTHROPIC_MODEL || "claude-3-5-haiku-latest",
      max_tokens: 160,
      system: "You evaluate text-to-speech narration instructions. Return compact JSON only.",
      messages: [{
        role: "user",
        content: `Instruction prompt:\n${instructions}\n\nArticle (${snippet.label}):\n${snippet.text}\n\nReturn JSON with naturalness, pacing, engagement, clarity scores from 1 to 10.`,
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic judge failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = payload.content?.find((item) => item.type === "text")?.text || "{}";
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) as Partial<DimensionScores> : {};
  const scores: DimensionScores = {
    naturalness: clamp(Number(parsed.naturalness ?? 5), 1, 10),
    pacing: clamp(Number(parsed.pacing ?? 5), 1, 10),
    engagement: clamp(Number(parsed.engagement ?? 5), 1, 10),
    clarity: clamp(Number(parsed.clarity ?? 5), 1, 10),
  };

  return {
    snippetId: snippet.id,
    label: snippet.label,
    scores,
    average: round2(average(Object.values(scores))),
  };
}

function averageDimensions(evaluations: SnippetEvaluation[]): DimensionScores {
  return {
    naturalness: round2(average(evaluations.map((value) => value.scores.naturalness))),
    pacing: round2(average(evaluations.map((value) => value.scores.pacing))),
    engagement: round2(average(evaluations.map((value) => value.scores.engagement))),
    clarity: round2(average(evaluations.map((value) => value.scores.clarity))),
  };
}

function keywordBonus(input: string, keywords: string[], bonusPerMatch: number): number {
  return keywords.reduce((score, keyword) => score + (input.includes(keyword) ? bonusPerMatch : 0), 0);
}

function rangeBonus(value: number, min: number, max: number, bonus: number): number {
  return value >= min && value <= max ? bonus : 0;
}

function hashText(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function previewInstructions(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function sanitize(value: string): string {
  return value.replace(/[\t\n\r]+/g, " ").trim();
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function loadCache(): Record<string, unknown> {
  if (!fs.existsSync(CACHE_FILE)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<string, unknown>;
}

function saveCache(cache: Record<string, unknown>): void {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
}
