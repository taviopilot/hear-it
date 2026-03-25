import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRunConfig,
  runAutoresearch,
  type AutoresearchAdapter,
  type CandidateScore,
  type ImprovementContext,
} from "./core.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const TTS_FILE = path.join(REPO_ROOT, "apps/api/src/tts.ts");
const RUN_LOG_FILE = process.env.AUTORESEARCH_RUN_LOG_FILE
  ? path.resolve(REPO_ROOT, process.env.AUTORESEARCH_RUN_LOG_FILE)
  : path.join(__dirname, "run-log.jsonl");

const LEAD_PHRASE = "Read this article aloud like a warm, conversational human podcast host";
const MODIFIER_PHRASES = [
  "in a natural, engaging style",
  "that is clear and easy to follow",
  "with clear delivery for technical ideas",
  "with warm podcast-level polish for the listener",
];
const PACING_PHRASES = [
  "with steady pace",
  "with brief pauses at headings and sentence boundaries",
  "with clean pacing for news and analysis",
  "with clean sentence boundaries",
  "with short pauses at section transitions",
];
const EMPHASIS_PHRASES = [
  "with subtle emphasis on key ideas",
  "that helps the listener track complex ideas",
  "with clarity for technical and news writing",
  "with natural emphasis on the most important ideas",
  "with engaging but measured delivery",
];
const CONNECTORS = ["", "while staying concise", "without sounding stiff", "without overdoing the performance"];

type PromptScore = CandidateScore<string>;

function readCurrentInstructions(): string {
  const source = fs.readFileSync(TTS_FILE, "utf8");
  const match =
    source.match(/DEFAULT_TTS_INSTRUCTIONS\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s) ??
    source.match(/DEFAULT_TTS_INSTRUCTIONS\s*=\s*`([^`]*)`/s);

  if (!match) {
    throw new Error(`Could not find DEFAULT_TTS_INSTRUCTIONS in ${TTS_FILE}`);
  }

  return match[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
}

function writeInstructions(candidate: string): void {
  const source = fs.readFileSync(TTS_FILE, "utf8");
  const updated = source.replace(
    /const DEFAULT_TTS_INSTRUCTIONS\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`);/s,
    `const DEFAULT_TTS_INSTRUCTIONS = ${JSON.stringify(candidate)};`,
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

function evaluateCandidate(candidate: string, judgeMode: string): PromptScore {
  const output = execFileSync(
    "yarn",
    ["workspace", "@hear-it/api", "exec", "tsx", "../../scripts/autoresearch/experiment.ts"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTORESEARCH_INSTRUCTIONS_OVERRIDE: candidate,
        AUTORESEARCH_JUDGE_MODE: judgeMode,
      },
    },
  );

  return {
    candidate,
    score: parseScore(output),
    promptHash: promptHash(candidate),
    description: candidate,
    estimatedCostUsd: 0,
  };
}

function commitImprovement(nextBest: PromptScore, context: ImprovementContext<string>, pushOnCommit: boolean): void {
  execFileSync("git", ["add", "apps/api/src/tts.ts", "scripts/autoresearch/results.tsv"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  execFileSync(
    "git",
    [
      "commit",
      "-m",
      `chore: autoresearch improve TTS prompt to ${nextBest.score.toFixed(4)}`,
      "-m",
      `Previous score: ${context.previousBest.score.toFixed(4)}\nNew score: ${nextBest.score.toFixed(4)}\nWindow: ${context.windowIndex}`,
    ],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
    },
  );

  if (pushOnCommit) {
    execFileSync("git", ["push", "origin", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
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

  for (const modifiers of choose(MODIFIER_PHRASES, 0, 3)) {
    for (const pacing of choose(PACING_PHRASES, 1, 3)) {
      for (const emphasis of choose(EMPHASIS_PHRASES, 1, 3)) {
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

async function main(): Promise<void> {
  const config = loadRunConfig(RUN_LOG_FILE);
  const adapter: AutoresearchAdapter<string> = {
    name: "hear-it-tts",
    evaluateBaseline() {
      const baselineInstructions = readCurrentInstructions();
      return evaluateCandidate(baselineInstructions, "heuristic-baseline");
    },
    buildCandidateQueue(currentBest) {
      return buildCandidates(currentBest.candidate);
    },
    evaluateCandidate(candidate, context) {
      const judgeMode = context.mode === "fast" ? "heuristic-fast" : `heuristic-window-${context.windowIndex}`;
      return evaluateCandidate(candidate, judgeMode);
    },
    applyImprovement(nextBest, context) {
      writeInstructions(nextBest.candidate);
      commitImprovement(nextBest, context, config.pushOnCommit);
    },
  };

  const summary = await runAutoresearch(adapter, config);

  console.log();
  console.log(`Finished ${summary.evaluated} evaluations with ${summary.improvements} improvements across ${summary.windowCount} experiment window(s).`);
  console.log(`Best score: ${summary.best.score.toFixed(4)}`);
  console.log(`Best prompt: ${summary.best.candidate}`);
  console.log(`Elapsed minutes: ${summary.elapsedMinutes.toFixed(2)}`);
  console.log(`Estimated cost: $${summary.estimatedCostUsd.toFixed(4)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
