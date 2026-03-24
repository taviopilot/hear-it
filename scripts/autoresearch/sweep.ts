import { appendResult, evaluateInstructions, extractCurrentInstructions } from "./lib.ts";

const current = extractCurrentInstructions();
const candidates = [
  {
    label: "baseline-current",
    instructions: current,
  },
  {
    label: "warm-concise",
    instructions:
      "Read the article in a warm, conversational voice with steady pacing, clear sentence endings, and subtle emphasis on the most important ideas.",
  },
  {
    label: "podcast-guide",
    instructions:
      "Read this like a calm podcast host explaining the article to one listener: warm, natural, and easy to follow, with short pauses at headings and sentence boundaries.",
  },
  {
    label: "clarity-first",
    instructions:
      "Deliver the article clearly and naturally. Keep a measured pace, make section breaks easy to hear, and slow down slightly for technical terms, names, quotes, and numbers.",
  },
  {
    label: "balanced-negative-guidance",
    instructions:
      "Read the article like a smart, calm narrator speaking to one listener. Keep a warm, conversational tone with steady pacing, brief pauses at headings and sentence boundaries, and subtle emphasis on key ideas, names, and transitions. Never rush dense passages, lists, quotes, or numbers, and avoid sounding robotic, flat, or theatrical.",
  },
  {
    label: "story-sensitive",
    instructions:
      "Use a clear, human delivery that stays measured and engaged. Let headings and transitions breathe, keep lists organized, and add gentle emphasis without drifting into announcer or audiobook drama.",
  },
];

async function main(): Promise<void> {
  const scored = [] as Array<{ label: string; composite: number; preview: string }>;

  for (const candidate of candidates) {
    const result = await evaluateInstructions(candidate.instructions);
    appendResult(result);
    scored.push({ label: candidate.label, composite: result.composite, preview: result.preview });
    console.log(`${candidate.label}\t${result.composite.toFixed(2)}\t${result.preview}`);
  }

  scored.sort((a, b) => b.composite - a.composite);
  console.log("\nRanked results:");
  for (const entry of scored) {
    console.log(`${entry.label}\t${entry.composite.toFixed(2)}\t${entry.preview}`);
  }
}

main().catch((error) => {
  console.error("Sweep failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
