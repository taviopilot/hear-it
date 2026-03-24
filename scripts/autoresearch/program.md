# Hear It — Low-Cost TTS Prompt Autoresearch

This adapts the spirit of PR #17 into a cheap-first loop.

## Goals
- Optimize `DEFAULT_TTS_INSTRUCTIONS` in `apps/api/src/tts.ts`
- Keep the default experiment loop free or near-free
- Make every run reproducible and cheap enough to leave running for hours

## Cheap-first loop
1. Run the local heuristic judge first:
   ```bash
   npx tsx scripts/autoresearch/experiment.ts
   ```
2. Record every result in `scripts/autoresearch/results.tsv`
3. Use `scripts/autoresearch/cache.json` to avoid rescoring the same prompt/snippet pair
4. Sweep multiple candidate prompts cheaply:
   ```bash
   npx tsx scripts/autoresearch/sweep.ts
   ```
5. Only use a paid judge later if you intentionally add one for finalists

## Why this differs from PR #17
PR #17 used an expensive LLM judge on every iteration. This version makes the default loop:
- local
- deterministic
- cached
- safe to run repeatedly

That makes it practical for overnight experimentation without surprise API spend.

## Notes
- `results.tsv` now logs judge mode, prompt hash, and per-benchmark scores
- The built-in prompt sweep is intentionally small and easy to extend
- Local heuristic scores are only a proxy, but they are fast enough to support broad search before any paid final check
