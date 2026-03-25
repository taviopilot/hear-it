import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CANDIDATES = [
  "Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries.",
  "Read this article aloud like a calm podcast host: natural, warm, and easy to follow, with steady pacing and clean sentence boundaries.",
  "Read this article aloud like a sharp, warm podcast narrator: conversational, steady, and easy to follow, with brief pauses at headings and sentence boundaries, subtle emphasis on key ideas, and no rushed or theatrical delivery.",
  "Narrate this article with a steady, conversational newsroom style: clear sentence boundaries, short pauses at headings, and subtle emphasis on important ideas without sounding dramatic.",
  "Read this article like a thoughtful audiobook essayist: warm, natural, and unhurried, with crisp sentence endings, gentle pauses, and light emphasis that helps listeners track the argument.",
  "Read this article aloud like a warm, conversational human podcast host, in a natural, engaging style, that is clear and easy to follow, with steady pace, with brief pauses at headings and sentence boundaries, with subtle emphasis on key ideas.",
];

type ScoredCandidate = {
  candidate: string;
  score: number;
};

function loadCandidates(): string[] {
  const candidatesFile = process.env.AUTORESEARCH_CANDIDATES_FILE;
  if (!candidatesFile) {
    return DEFAULT_CANDIDATES;
  }

  const resolved = path.resolve(REPO_ROOT, candidatesFile);
  const entries = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  if (!Array.isArray(entries) || !entries.every((item) => typeof item === "string")) {
    throw new Error(`Expected ${resolved} to contain a JSON array of strings.`);
  }

  return entries;
}

function runExperiment(candidate: string): number {
  const output = execFileSync("yarn", ["workspace", "@hear-it/api", "exec", "tsx", "../../scripts/autoresearch/experiment.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTORESEARCH_INSTRUCTIONS_OVERRIDE: candidate,
      AUTORESEARCH_JUDGE_MODE: process.env.AUTORESEARCH_JUDGE_MODE ?? "heuristic-sweep",
    },
  });
  const match = output.match(/autoresearch_score:(\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse autoresearch score from output:\n${output}`);
  }
  return Number(match[1]);
}

function main(): void {
  const scored: ScoredCandidate[] = [];

  for (const candidate of loadCandidates()) {
    const score = runExperiment(candidate);
    scored.push({ candidate, score });
    console.log(`${score.toFixed(4)}\t${candidate}`);
  }

  console.log();
  console.log("Ranked results:");
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    console.log(`${item.score.toFixed(4)}\t${item.candidate}`);
  }
}

main();
