import { appendResult, evaluateInstructions, extractCurrentInstructions, formatSummary } from "./lib.ts";

async function main(): Promise<void> {
  const instructions = process.env.AUTORESEARCH_INSTRUCTIONS_OVERRIDE?.trim() || extractCurrentInstructions();
  const result = await evaluateInstructions(instructions);

  console.log("=".repeat(60));
  console.log("Hear It TTS Autoresearch — Experiment");
  console.log("=".repeat(60));
  console.log(`Instructions: \"${result.preview}${instructions.length > result.preview.length ? "…" : ""}\"`);
  console.log(formatSummary(result));
  appendResult(result);
  console.log("Result appended to scripts/autoresearch/results.tsv");
  console.log(`autoresearch_score:${result.composite.toFixed(2)}`);
}

main().catch((error) => {
  console.error("Experiment failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
