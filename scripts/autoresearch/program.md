# Hear It — Cheap-First TTS Autoresearch

## Mission

Improve the default narration instructions in `apps/api/src/tts.ts` while keeping the experiment loop cheap enough to run for long stretches without burning paid tokens.

## Principles

1. **Do not edit `tts.ts` for every candidate.** Use `AUTORESEARCH_INSTRUCTIONS_OVERRIDE` or `scripts/autoresearch/sweep.ts` to score candidates cheaply first.
2. **Default to heuristic judging.** `AUTORESEARCH_JUDGE=auto` falls back to the built-in heuristic judge when no Anthropic key is present.
3. **Use paid judging only for finalists.** If `ANTHROPIC_API_KEY` is available, rerun the top 1–3 prompts with `AUTORESEARCH_JUDGE=anthropic`.
4. **Commit only real winners.** After a sweep, update `DEFAULT_TTS_INSTRUCTIONS` once with the best candidate and keep the results log.
5. **Keep runs reproducible.** Results are appended to `results.tsv`, keyed by prompt hash and judge mode, and per-snippet scores are cached in `cache.json`.

## Human operator instructions

If you want to replicate this with a strong coding agent, tell it something like:

"Read `scripts/autoresearch/program.md`. Do setup first. Confirm you are in the Hear It repo, inspect the current branch, make sure dependencies are installed, and then run the cheap-first TTS autoresearch workflow. Use heuristic judging by default, only use paid judging for finalists, avoid editing `apps/api/src/tts.ts` for one-off candidates, keep the run reproducible, and summarize the winning prompt plus exact commands you ran."

"Setup first" should mean:
- confirm the repo/worktree and branch
- inspect `git status`
- ensure the workspace dependencies are installed
- read this file before running anything
- run the baseline once before changing strategy

## Commands

Baseline / current prompt:

```bash
cd apps/api && npx tsx ../../scripts/autoresearch/experiment.ts
```

Run the curated sweep:

```bash
cd apps/api && npx tsx ../../scripts/autoresearch/sweep.ts
```

Try a one-off candidate without editing source:

```bash
cd apps/api && \
AUTORESEARCH_INSTRUCTIONS_OVERRIDE="Read the article..." \
npx tsx ../../scripts/autoresearch/experiment.ts
```

Optional paid validation for finalists:

```bash
cd apps/api && \
AUTORESEARCH_JUDGE=anthropic \
ANTHROPIC_API_KEY=*** \
npx tsx ../../scripts/autoresearch/experiment.ts
```

## Cadence / timing

These cheap-first experiments do not run on a fixed 5-minute interval. Each command runs immediately when invoked.
- `experiment.ts` runs one evaluation and exits
- `sweep.ts` runs a finite batch of candidate evaluations and exits
- if you want recurring runs, use an external scheduler; the scripts themselves are on-demand

## What the heuristic judge rewards

- warm, conversational, non-theatrical delivery
- explicit pacing guidance
- pauses at headings and sentence boundaries
- clarity for lists, quotes, numbers, names, and transitions
- instructions long enough to be specific, but not bloated

## What to avoid

- expensive judge loops as the default inner loop
- editing and reverting `tts.ts` on every experiment
- results without prompt hashes or judge-mode provenance
- fake audio when a free local provider is available
