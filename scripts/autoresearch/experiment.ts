import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const TTS_FILE = path.join(REPO_ROOT, "apps/api/src/tts.ts");
const DEFAULT_RESULTS_FILE = path.join(__dirname, "results.tsv");
const DEFAULT_CACHE_FILE = path.join(__dirname, "cache.json");
const RESULTS_FILE = process.env.AUTORESEARCH_RESULTS_FILE
  ? path.resolve(REPO_ROOT, process.env.AUTORESEARCH_RESULTS_FILE)
  : DEFAULT_RESULTS_FILE;
const CACHE_FILE = process.env.AUTORESEARCH_CACHE_FILE
  ? path.resolve(REPO_ROOT, process.env.AUTORESEARCH_CACHE_FILE)
  : DEFAULT_CACHE_FILE;
const RESULTS_HEADER = [
  "experiment_id",
  "timestamp",
  "judge_mode",
  "composite_score",
  "prompt_hash",
  "technical_score",
  "news_score",
  "narrative_score",
  "instructions_preview",
].join("\t") + "\n";

const BENCHMARK_SNIPPETS = [
  {
    id: "technical",
    label: "Technical / science article",
    text: "The transformer architecture, introduced in 2017, revolutionized natural language processing. At its core, transformers use a self-attention mechanism that weighs the relevance of every token against every other token in a sequence simultaneously. One continuing challenge is the quadratic memory cost of full self-attention as sequence length grows.",
  },
  {
    id: "news",
    label: "Breaking news article",
    text: "Scientists announced a significant breakthrough in battery technology this week, claiming their new lithium-sulfur cells can store up to five times the energy of conventional lithium-ion batteries. Independent experts called the results promising but said manufacturing and cost challenges remain.",
  },
  {
    id: "narrative",
    label: "Longform narrative / opinion",
    text: "Walking through the old quarter at dusk, she noticed how the fading light transformed the familiar into something almost luminous. There is a particular tenderness reserved for things you are about to lose, a sharpness of attention that ordinary life rarely demands.",
  },
] as const;

type HeuristicBreakdown = {
  naturalness: number;
  pacing: number;
  engagement: number;
  clarity: number;
};

type CacheRecord = Record<string, { average: number; scores: HeuristicBreakdown }>;

type Evaluation = {
  snippetId: string;
  cached: boolean;
  average: number;
  scores: HeuristicBreakdown;
};

function extractCurrentInstructions(): string {
  const source = fs.readFileSync(TTS_FILE, "utf8");
  const match =
    source.match(/DEFAULT_TTS_INSTRUCTIONS\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s) ??
    source.match(/DEFAULT_TTS_INSTRUCTIONS\s*=\s*`([^`]*)`/s);

  if (!match) {
    throw new Error(`Could not find DEFAULT_TTS_INSTRUCTIONS in ${TTS_FILE}`);
  }

  return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
}

function getInstructionsUnderTest(): string {
  return process.env.AUTORESEARCH_INSTRUCTIONS_OVERRIDE?.trim() || extractCurrentInstructions();
}

function clamp(value: number, min = 1, max = 10): number {
  return Math.max(min, Math.min(max, value));
}

function keywordHits(instructions: string, keywords: string[]): number {
  return keywords.filter((keyword) => instructions.includes(keyword)).length;
}

function scoreSnippet(instructionsRaw: string, snippetId: string): { average: number; scores: HeuristicBreakdown } {
  const instructions = instructionsRaw.toLowerCase();
  const words = instructions.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const naturalness = clamp(
    5.4 +
      keywordHits(instructions, ["natural", "warm", "conversational", "human", "podcast"]) * 0.7 -
      keywordHits(instructions, ["dramatic", "theatrical", "robotic", "monotone"]) * 0.8,
  );

  const pacing = clamp(
    5.1 +
      keywordHits(instructions, ["steady", "pace", "pauses", "pause", "sentence boundaries", "headings", "rushed"]) * 0.65 +
      (wordCount >= 16 && wordCount <= 40 ? 0.6 : 0) -
      (wordCount > 55 ? 0.8 : 0),
  );

  const engagement = clamp(
    5 +
      keywordHits(instructions, ["engaging", "listener", "curious", "podcast", "subtle emphasis", "key ideas"]) * 0.6 -
      keywordHits(instructions, ["flat", "monotone"]) * 0.9,
  );

  let clarity =
    5.2 +
    keywordHits(instructions, ["clear", "easy to follow", "clarity", "headings", "sentence boundaries", "key ideas"]) * 0.6;

  if (snippetId === "technical") {
    clarity += keywordHits(instructions, ["complex", "technical", "easy to follow"]) * 0.45;
  }
  if (snippetId === "news") {
    clarity += keywordHits(instructions, ["steady", "clean", "clear"]) * 0.25;
  }

  const scores: HeuristicBreakdown = {
    naturalness,
    pacing,
    engagement,
    clarity: clamp(clarity),
  };

  const average = (scores.naturalness + scores.pacing + scores.engagement + scores.clarity) / 4;
  return { average, scores };
}

function promptHash(instructions: string): string {
  return crypto.createHash("sha256").update(instructions).digest("hex").slice(0, 12);
}

function loadCache(): CacheRecord {
  if (!fs.existsSync(CACHE_FILE)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as CacheRecord;
}

function saveCache(cache: CacheRecord): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function ensureResultsHeader(): void {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, RESULTS_HEADER);
  }
}

function evaluateInstructions(instructions: string): Evaluation[] {
  const hash = promptHash(instructions);
  const cache = loadCache();
  const evaluations = BENCHMARK_SNIPPETS.map((snippet) => {
    const cacheKey = `${hash}:${snippet.id}`;
    const cached = cache[cacheKey];
    if (cached) {
      return { snippetId: snippet.id, cached: true, ...cached };
    }

    const computed = scoreSnippet(instructions, snippet.id);
    cache[cacheKey] = computed;
    return { snippetId: snippet.id, cached: false, ...computed };
  });

  saveCache(cache);
  return evaluations;
}

function emitJson(payload: object): void {
  if (process.env.AUTORESEARCH_PRINT_JSON === "1") {
    console.log(JSON.stringify(payload, null, 2));
  }
}

async function main(): Promise<void> {
  const instructions = getInstructionsUnderTest();
  const preview = instructions.slice(0, 96).replace(/\t/g, " ").replace(/\n/g, " ");
  const hash = promptHash(instructions);
  const evaluations = evaluateInstructions(instructions);

  console.log("=".repeat(60));
  console.log("Hear It TTS Autoresearch — local heuristic judge");
  console.log("=".repeat(60));
  console.log(`Instructions: \"${preview}${instructions.length > 96 ? "…" : ""}\"`);
  console.log();

  for (const evaluation of evaluations) {
    const { naturalness, pacing, engagement, clarity } = evaluation.scores;
    console.log(
      `  [${evaluation.snippetId}] avg=${evaluation.average.toFixed(2)} ` +
        `(nat=${naturalness.toFixed(2)} pac=${pacing.toFixed(2)} eng=${engagement.toFixed(2)} cla=${clarity.toFixed(2)})` +
        (evaluation.cached ? " [cache]" : ""),
    );
  }

  const composite = evaluations.reduce((sum, item) => sum + item.average, 0) / evaluations.length;
  ensureResultsHeader();

  const row = [
    Date.now().toString(),
    new Date().toISOString(),
    process.env.AUTORESEARCH_JUDGE_MODE ?? "heuristic-local",
    composite.toFixed(4),
    hash,
    evaluations[0]?.average.toFixed(4) ?? "",
    evaluations[1]?.average.toFixed(4) ?? "",
    evaluations[2]?.average.toFixed(4) ?? "",
    preview,
  ].join("\t") + "\n";
  fs.appendFileSync(RESULTS_FILE, row);

  emitJson({
    composite,
    promptHash: hash,
    resultsFile: path.relative(REPO_ROOT, RESULTS_FILE),
    cacheFile: path.relative(REPO_ROOT, CACHE_FILE),
    evaluations,
    instructions,
  });

  console.log();
  console.log(`Composite score: ${composite.toFixed(4)} / 10`);
  console.log(`Prompt hash: ${hash}`);
  console.log(`Result appended to ${path.relative(REPO_ROOT, RESULTS_FILE)}`);
  console.log(`autoresearch_score:${composite.toFixed(4)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
