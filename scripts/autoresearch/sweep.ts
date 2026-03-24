import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const TTS_FILE = path.join(REPO_ROOT, "apps/api/src/tts.ts");

const CANDIDATES = [
  "Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries.",
  "Read this article aloud like a calm podcast host: natural, warm, and easy to follow, with steady pacing and clean sentence boundaries.",
  "Read this article aloud like a sharp, warm podcast narrator: conversational, steady, and easy to follow, with brief pauses at headings and sentence boundaries, subtle emphasis on key ideas, and no rushed or theatrical delivery.",
  "Narrate this article with a steady, conversational newsroom style: clear sentence boundaries, short pauses at headings, and subtle emphasis on important ideas without sounding dramatic.",
  "Read this article like a thoughtful audiobook essayist: warm, natural, and unhurried, with crisp sentence endings, gentle pauses, and light emphasis that helps listeners track the argument.",
];

function replaceInstructions(candidate: string): void {
  const source = fs.readFileSync(TTS_FILE, "utf8");
  const next = source.replace(
    /export const DEFAULT_TTS_INSTRUCTIONS\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`);/s,
    `export const DEFAULT_TTS_INSTRUCTIONS = ${JSON.stringify(candidate)};`,
  );
  fs.writeFileSync(TTS_FILE, next);
}

function runExperiment(): number {
  const output = execFileSync("npx", ["tsx", "scripts/autoresearch/experiment.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const match = output.match(/autoresearch_score:(\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse autoresearch score from output:\n${output}`);
  }
  return Number(match[1]);
}

function main(): void {
  const original = fs.readFileSync(TTS_FILE, "utf8");
  const scored: Array<{ candidate: string; score: number }> = [];

  try {
    for (const candidate of CANDIDATES) {
      replaceInstructions(candidate);
      const score = runExperiment();
      scored.push({ candidate, score });
      console.log(`${score.toFixed(4)}\t${candidate}`);
    }
  } finally {
    fs.writeFileSync(TTS_FILE, original);
  }

  console.log();
  console.log("Ranked results:");
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    console.log(`${item.score.toFixed(4)}\t${item.candidate}`);
  }
}

main();
