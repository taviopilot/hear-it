import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const TTS_FILE = path.join(REPO_ROOT, "apps/api/src/tts.ts");
const RUN_LOG_FILE = path.join(__dirname, "run-log.jsonl");

const LEAD_PHRASE = "Read this article aloud like a warm, conversational human podcast host";
const MODIFIER_PHRASES = [
  "in a natural, engaging style",
  "that is clear and easy to follow",
];
const PACING_PHRASES = [
  "with steady pace",
  "with brief pauses at headings and sentence boundaries",
  "with clean pacing for news and analysis",
];
const EMPHASIS_PHRASES = [
  "with subtle emphasis on key ideas",
  "that helps the listener track complex ideas",
  "with clarity for technical and news writing",
];
const CONNECTORS = ["", "while staying concise", "without sounding stiff"];

type CandidateScore = {
  candidate: string;
  score: number;
  promptHash: string;
};

type RunConfig = {
  durationMinutes: number;
  maxIterations: number;
  minImprovement: number;
  pushOnCommit: boolean;
  maxEstimatedCostUsd: number;
};

function readCurrentInstructions(): string {
  const source = fs.readFileSync(TTS_FILE, "utf8");
  const match =
    source.match(/DEFAULT_TTS_INSTRUCTIONS\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s) ??
    source.match(/DEFAULT_TTS_INSTRUCTIONS\s*=\s*`([^`]*)`/s);

  if (!match) {
    throw new Error(`Could not find DEFAULT_TTS_INSTRUCTIONS in ${TTS_FILE}`);
  }

  return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
}

function writeInstructions(candidate: string): void {
  const source = fs.readFileSync(TTS_FILE, "utf8");
  const updated = source.replace(
    /export const DEFAULT_TTS_INSTRUCTIONS\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`);/s,
    `export const DEFAULT_TTS_INSTRUCTIONS = ${JSON.stringify(candidate)};`,
  );

  if (updated === source) {
    throw new Error("Failed to update DEFAULT_TTS_INSTRUCTIONS.");
  }

  fs.writeFileSync(TTS_FILE, updated);
}

function promptHash(candidate: string): string {
  return crypto.createHash("sha256").update(candidate).digest("hex").slice(0, 12);
}

function parseScore(output: string): number {
  const match = output.match(/autoresearch_score:(\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse autoresearch score from output:\n${output}`);
  }
  return Number(match[1]);
}

function evaluateCandidate(candidate: string, judgeMode = "heuristic-runner"): CandidateScore {
  const output = execFileSync("yarn", ["workspace", "@hear-it/api", "exec", "tsx", "../../scripts/autoresearch/experiment.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTORESEARCH_INSTRUCTIONS_OVERRIDE: candidate,
      AUTORESEARCH_JUDGE_MODE: judgeMode,
    },
  });

  return {
    candidate,
    score: parseScore(output),
    promptHash: promptHash(candidate),
  };
}

function commitImprovement(score: number, previousScore: number): void {
  execFileSync("git", ["add", "apps/api/src/tts.ts", "scripts/autoresearch/results.tsv"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  execFileSync(
    "git",
    [
      "commit",
      "-m",
      `chore: autoresearch improve TTS prompt to ${score.toFixed(4)}`,
      "-m",
      `Previous score: ${previousScore.toFixed(4)}\nNew score: ${score.toFixed(4)}`,
    ],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
    },
  );
}

function maybePush(pushOnCommit: boolean): void {
  if (!pushOnCommit) {
    return;
  }

  execFileSync("git", ["push", "origin", "HEAD"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

function appendRunLog(event: object): void {
  fs.appendFileSync(RUN_LOG_FILE, `${JSON.stringify(event)}\n`);
}

function dedupe(candidates: string[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function choose<T>(items: T[], minItems: number, maxItems: number): T[][] {
  const results: T[][] = [];

  function visit(index: number, current: T[]): void {
    if (current.length >= minItems && current.length <= maxItems) {
      results.push([...current]);
    }
    if (current.length === maxItems) {
      return;
    }

    for (let i = index; i < items.length; i += 1) {
      current.push(items[i]!);
      visit(i + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return results;
}

function buildCandidate(modifiers: string[], pacing: string[], emphasis: string[], connector: string): string {
  return [LEAD_PHRASE, ...modifiers, ...pacing, ...emphasis, connector]
    .filter(Boolean)
    .join(", ")
    .replace(/, (while staying concise|without sounding stiff)$/u, " $1") + ".";
}

function buildCandidates(current: string): string[] {
  const candidates: string[] = [current];

  for (const modifiers of choose(MODIFIER_PHRASES, 0, MODIFIER_PHRASES.length)) {
    for (const pacing of choose(PACING_PHRASES, 1, 2)) {
      for (const emphasis of choose(EMPHASIS_PHRASES, 1, 2)) {
        for (const connector of CONNECTORS) {
          candidates.push(buildCandidate(modifiers, pacing, emphasis, connector));
        }
      }
    }
  }

  candidates.push(
    "Read this article aloud like a warm, conversational human podcast host, in a natural, engaging style, that is clear and easy to follow, with steady pace, with brief pauses at headings and sentence boundaries, with subtle emphasis on key ideas.",
    "Read this article aloud like a warm, conversational human podcast host, in a natural, engaging style, that is clear and easy to follow, with steady pace, with brief pauses at headings and sentence boundaries, with subtle emphasis on key ideas, that helps the listener track complex ideas.",
    "Read this article aloud like a warm, conversational human podcast host, in a natural, engaging style, that is clear and easy to follow, with steady pace, with brief pauses at headings and sentence boundaries, with subtle emphasis on key ideas, with clarity for technical and news writing.",
  );

  return dedupe(candidates);
}

function loadConfig(): RunConfig {
  return {
    durationMinutes: Number(process.env.AUTORESEARCH_DURATION_MINUTES ?? "180"),
    maxIterations: Number(process.env.AUTORESEARCH_MAX_ITERATIONS ?? "500"),
    minImprovement: Number(process.env.AUTORESEARCH_MIN_IMPROVEMENT ?? "0.0001"),
    pushOnCommit: process.env.AUTORESEARCH_PUSH === "1",
    maxEstimatedCostUsd: Number(process.env.AUTORESEARCH_MAX_ESTIMATED_COST_USD ?? "0.5"),
  };
}

function main(): void {
  const config = loadConfig();
  const startedAt = Date.now();
  const deadline = startedAt + config.durationMinutes * 60_000;
  const baselineInstructions = readCurrentInstructions();
  let best = evaluateCandidate(baselineInstructions, "heuristic-baseline");
  let estimatedCostUsd = 0;

  console.log(`Baseline score: ${best.score.toFixed(4)} (${best.promptHash})`);
  appendRunLog({
    type: "baseline",
    timestamp: new Date().toISOString(),
    score: best.score,
    promptHash: best.promptHash,
  });

  const queue = buildCandidates(baselineInstructions).map((candidate) => ({
    candidate,
    promptHash: promptHash(candidate),
  }));
  const seen = new Set<string>();
  let evaluated = 0;
  let improvements = 0;

  while (Date.now() < deadline && evaluated < config.maxIterations && queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.promptHash)) {
      continue;
    }
    seen.add(next.promptHash);

    const scored = evaluateCandidate(next.candidate);
    evaluated += 1;
    appendRunLog({
      type: "evaluation",
      timestamp: new Date().toISOString(),
      score: scored.score,
      promptHash: scored.promptHash,
      candidate: scored.candidate,
    });
    console.log(`[${evaluated}] ${scored.score.toFixed(4)} ${scored.promptHash} ${scored.candidate}`);

    if (estimatedCostUsd > config.maxEstimatedCostUsd) {
      console.log(`Stopping: estimated cost ${estimatedCostUsd.toFixed(4)} exceeded budget.`);
      break;
    }

    if (scored.score > best.score + config.minImprovement) {
      const previousBest = best;
      best = scored;
      improvements += 1;
      writeInstructions(best.candidate);
      commitImprovement(best.score, previousBest.score);
      maybePush(config.pushOnCommit);
      appendRunLog({
        type: "improvement",
        timestamp: new Date().toISOString(),
        score: best.score,
        previousScore: previousBest.score,
        promptHash: best.promptHash,
        candidate: best.candidate,
      });
    }
  }

  console.log();
  console.log(`Finished ${evaluated} evaluations with ${improvements} improvements.`);
  console.log(`Best score: ${best.score.toFixed(4)}`);
  console.log(`Best prompt: ${best.candidate}`);
  console.log(`Elapsed minutes: ${((Date.now() - startedAt) / 60_000).toFixed(2)}`);
  console.log(`Estimated cost: $${estimatedCostUsd.toFixed(4)}`);
}

main();
