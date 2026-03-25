# Hear It — Budgeted TTS Prompt Autoresearch

This loop borrows the Karpathy-style autoresearch pattern:
- inspect the current program state
- propose prompt edits
- run an experiment
- keep improvements
- repeat for a long bounded window

For Hear It, the thing being optimized is `DEFAULT_TTS_INSTRUCTIONS` in `apps/api/src/tts.ts`.

## Constraints
- Default to a local heuristic judge.
- Keep total estimated spend under `$0.50` for the full run.
- Prefer zero-cost experimentation unless a human explicitly opts into a paid finalist pass.
- Make commits only when the score improves.
- Never run forever. Every loop must be bounded by time, iterations, and budget.

## Human operator instructions
If you want to replicate this with a strong coding agent, tell it something like:

"Read `scripts/autoresearch/program.md`. Do setup first. Confirm you are in the Hear It repo, inspect the current branch, make sure dependencies are installed, and then run the bounded TTS autoresearch workflow. Stay within the documented budget guardrails, use the cheap heuristic path by default, commit only genuine improvements, and summarize the best prompt plus exact commands you ran."

"Setup first" should mean:
- confirm the repo/worktree and branch
- inspect `git status`
- ensure the workspace dependencies are installed
- read this file before running anything
- run the baseline once before starting the bounded loop

## Cheap-first workflow
1. Measure the current prompt.
   `yarn workspace @hear-it/api exec tsx ../../scripts/autoresearch/experiment.ts`
2. Sweep easy candidate variations without editing the production file.
   `yarn workspace @hear-it/api exec tsx ../../scripts/autoresearch/sweep.ts`
3. Run the bounded loop.
   `AUTORESEARCH_DURATION_MINUTES=180 AUTORESEARCH_MAX_ESTIMATED_COST_USD=0.50 yarn workspace @hear-it/api exec tsx ../../scripts/autoresearch/run.ts`
4. Let the loop commit only genuine score improvements.
5. Push the branch when you are happy with the result, or set `AUTORESEARCH_PUSH=1` to push on each improved commit.

## Cadence / timing
These experiments do not run on a fixed 5-minute interval.
- `experiment.ts` runs one evaluation and exits
- `sweep.ts` runs a finite batch and exits
- `run.ts` loops continuously until it hits its time, iteration, or budget limits
- if you want a 5-minute schedule, that must be provided by an external scheduler; the current scripts do not sleep for 5 minutes between evaluations

## Experiment design
The heuristic judge scores three benchmark article types:
- technical
- news
- narrative

Each candidate is scored on four axes:
- naturalness
- pacing
- engagement
- clarity

The score is only a cheap proxy. Use it to search broadly. If later needed, validate finalists with a tiny paid model or real listening tests.

## Safety rails
- `AUTORESEARCH_DURATION_MINUTES` bounds wall-clock runtime.
- `AUTORESEARCH_MAX_ITERATIONS` bounds candidate count.
- `AUTORESEARCH_MAX_ESTIMATED_COST_USD` bounds cost.
- `AUTORESEARCH_MIN_IMPROVEMENT` avoids noisy no-op commits.
- `AUTORESEARCH_INSTRUCTIONS_OVERRIDE` lets you test candidates without mutating `tts.ts`.

## Files
- `experiment.ts` — local heuristic judge with caching and TSV logging
- `sweep.ts` — cheap candidate sweep using override mode
- `run.ts` — bounded autoresearch loop with git commits on improvements
- `results.tsv` — cumulative experiment log
- `run-log.jsonl` — untracked run log for a specific long run
- `cache.json` — untracked prompt/snippet score cache

## Practical guidance
- Favor concise prompts with specific delivery cues.
- Avoid wording that accidentally trips negative heuristics unless you intend it.
- When you find a winner, keep the instructions readable to humans even if the proxy likes denser keyword coverage.
- If the loop stalls, add new candidate templates rather than removing the guardrails.
