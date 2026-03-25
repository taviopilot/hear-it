import fs from "node:fs";
import path from "node:path";

export type AutoresearchMode = "windowed" | "fast";

export type CandidateScore<TCandidate> = {
  candidate: TCandidate;
  score: number;
  promptHash: string;
  description: string;
  estimatedCostUsd?: number;
};

export type AutoresearchRunConfig = {
  mode: AutoresearchMode;
  durationMinutes: number;
  experimentDurationMinutes: number;
  maxIterations: number;
  minImprovement: number;
  pushOnCommit: boolean;
  maxEstimatedCostUsd: number;
  intervalSeconds: number;
  logFile: string;
};

export type EvaluationContext = {
  windowIndex: number;
  evaluationIndex: number;
  experimentDurationMinutes: number;
  mode: AutoresearchMode;
};

export type ImprovementContext<TCandidate> = {
  windowIndex: number;
  improvementIndex: number;
  previousBest: CandidateScore<TCandidate>;
};

export type AutoresearchAdapter<TCandidate> = {
  name: string;
  evaluateBaseline(): CandidateScore<TCandidate>;
  buildCandidateQueue(currentBest: CandidateScore<TCandidate>): TCandidate[];
  evaluateCandidate(candidate: TCandidate, context: EvaluationContext): CandidateScore<TCandidate>;
  applyImprovement(nextBest: CandidateScore<TCandidate>, context: ImprovementContext<TCandidate>): void;
};

export type AutoresearchSummary<TCandidate> = {
  best: CandidateScore<TCandidate>;
  evaluated: number;
  improvements: number;
  elapsedMinutes: number;
  estimatedCostUsd: number;
  windowCount: number;
};

export function loadRunConfig(logFile: string): AutoresearchRunConfig {
  const mode = normalizeMode(process.env.AUTORESEARCH_MODE);
  const durationMinutes = parsePositiveNumber(process.env.AUTORESEARCH_DURATION_MINUTES, 180);
  const experimentDurationMinutes = parsePositiveNumber(process.env.AUTORESEARCH_EXPERIMENT_DURATION_MINUTES, 5);
  const maxIterations = parsePositiveInteger(process.env.AUTORESEARCH_MAX_ITERATIONS, 500);
  const minImprovement = parseNonNegativeNumber(process.env.AUTORESEARCH_MIN_IMPROVEMENT, 0.0001);
  const maxEstimatedCostUsd = parseNonNegativeNumber(process.env.AUTORESEARCH_MAX_ESTIMATED_COST_USD, 0.5);
  const intervalSeconds = parseNonNegativeNumber(process.env.AUTORESEARCH_INTERVAL_SECONDS, 0);

  return {
    mode,
    durationMinutes,
    experimentDurationMinutes,
    maxIterations,
    minImprovement,
    pushOnCommit: process.env.AUTORESEARCH_PUSH === "1",
    maxEstimatedCostUsd,
    intervalSeconds,
    logFile,
  };
}

export async function runAutoresearch<TCandidate>(
  adapter: AutoresearchAdapter<TCandidate>,
  config: AutoresearchRunConfig,
): Promise<AutoresearchSummary<TCandidate>> {
  const startedAt = Date.now();
  const hardDeadline = startedAt + config.durationMinutes * 60_000;
  let best = adapter.evaluateBaseline();
  let estimatedCostUsd = best.estimatedCostUsd ?? 0;
  let evaluated = 0;
  let improvements = 0;
  let windowIndex = 0;
  let budgetExceeded = false;

  const queue: TCandidate[] = [];
  const seenPromptHashes = new Set<string>([best.promptHash]);
  enqueueCandidates(queue, adapter.buildCandidateQueue(best));

  appendJsonl(config.logFile, {
    type: "baseline",
    timestamp: new Date().toISOString(),
    name: adapter.name,
    mode: config.mode,
    durationMinutes: config.durationMinutes,
    experimentDurationMinutes: config.experimentDurationMinutes,
    maxIterations: config.maxIterations,
    maxEstimatedCostUsd: config.maxEstimatedCostUsd,
    score: best.score,
    promptHash: best.promptHash,
    candidate: best.description,
  });

  console.log(`Baseline score: ${best.score.toFixed(4)} (${best.promptHash})`);
  console.log(`Mode: ${config.mode}`);
  console.log(
    `Experiment window: ${config.mode === "fast" ? "1 candidate per experiment" : `${config.experimentDurationMinutes.toFixed(2)} minutes`}`,
  );
  console.log(`Max runtime: ${config.durationMinutes.toFixed(2)} minutes`);
  console.log(`Interval between windows: ${config.intervalSeconds.toFixed(2)} seconds`);

  while (Date.now() < hardDeadline && evaluated < config.maxIterations && queue.length > 0 && !budgetExceeded) {
    windowIndex += 1;
    const windowStartedAt = Date.now();
    const windowDeadline = config.mode === "fast"
      ? windowStartedAt
      : Math.min(hardDeadline, windowStartedAt + config.experimentDurationMinutes * 60_000);
    const windowResults: CandidateScore<TCandidate>[] = [];

    appendJsonl(config.logFile, {
      type: "window_started",
      timestamp: new Date().toISOString(),
      windowIndex,
      queueLength: queue.length,
      mode: config.mode,
      experimentDurationMinutes: config.experimentDurationMinutes,
    });

    while (
      Date.now() < hardDeadline &&
      evaluated < config.maxIterations &&
      queue.length > 0 &&
      (config.mode === "fast" ? windowResults.length < 1 : Date.now() < windowDeadline)
    ) {
      const candidate = queue.shift();
      if (candidate === undefined) {
        break;
      }

      const scored = adapter.evaluateCandidate(candidate, {
        windowIndex,
        evaluationIndex: evaluated + 1,
        experimentDurationMinutes: config.experimentDurationMinutes,
        mode: config.mode,
      });

      if (seenPromptHashes.has(scored.promptHash)) {
        appendJsonl(config.logFile, {
          type: "evaluation_skipped_duplicate",
          timestamp: new Date().toISOString(),
          windowIndex,
          promptHash: scored.promptHash,
          candidate: scored.description,
        });
        continue;
      }

      seenPromptHashes.add(scored.promptHash);
      evaluated += 1;
      estimatedCostUsd += scored.estimatedCostUsd ?? 0;
      windowResults.push(scored);

      appendJsonl(config.logFile, {
        type: "evaluation",
        timestamp: new Date().toISOString(),
        windowIndex,
        evaluationIndex: evaluated,
        score: scored.score,
        promptHash: scored.promptHash,
        candidate: scored.description,
        estimatedCostUsd,
      });

      console.log(
        `[window ${windowIndex} eval ${windowResults.length}] ${scored.score.toFixed(4)} ${scored.promptHash} ${scored.description}`,
      );

      if (estimatedCostUsd > config.maxEstimatedCostUsd) {
        budgetExceeded = true;
        console.log(`Stopping: estimated cost ${estimatedCostUsd.toFixed(4)} exceeded budget.`);
        appendJsonl(config.logFile, {
          type: "budget_exceeded",
          timestamp: new Date().toISOString(),
          windowIndex,
          estimatedCostUsd,
          maxEstimatedCostUsd: config.maxEstimatedCostUsd,
        });
        break;
      }
    }

    if (windowResults.length === 0) {
      appendJsonl(config.logFile, {
        type: "window_completed",
        timestamp: new Date().toISOString(),
        windowIndex,
        evaluations: 0,
        improvement: false,
        queueLength: queue.length,
      });
      break;
    }

    const windowBest = windowResults.reduce((currentBest, candidate) => (
      candidate.score > currentBest.score ? candidate : currentBest
    ));
    const improved = windowBest.score > best.score + config.minImprovement;

    appendJsonl(config.logFile, {
      type: "window_completed",
      timestamp: new Date().toISOString(),
      windowIndex,
      evaluations: windowResults.length,
      improvement: improved,
      windowBestScore: windowBest.score,
      windowBestHash: windowBest.promptHash,
      globalBestScore: best.score,
      queueLength: queue.length,
    });

    console.log(
      `Window ${windowIndex} complete: ${windowResults.length} evaluation(s), best ${windowBest.score.toFixed(4)} (${windowBest.promptHash})`,
    );

    if (improved) {
      const previousBest = best;
      best = windowBest;
      improvements += 1;
      adapter.applyImprovement(best, {
        windowIndex,
        improvementIndex: improvements,
        previousBest,
      });
      enqueueCandidates(queue, adapter.buildCandidateQueue(best));
      appendJsonl(config.logFile, {
        type: "improvement",
        timestamp: new Date().toISOString(),
        windowIndex,
        improvementIndex: improvements,
        score: best.score,
        previousScore: previousBest.score,
        promptHash: best.promptHash,
        candidate: best.description,
      });
    }

    if (
      config.mode === "windowed" &&
      config.intervalSeconds > 0 &&
      Date.now() < hardDeadline &&
      evaluated < config.maxIterations &&
      queue.length > 0 &&
      !budgetExceeded
    ) {
      appendJsonl(config.logFile, {
        type: "window_sleep",
        timestamp: new Date().toISOString(),
        windowIndex,
        intervalSeconds: config.intervalSeconds,
      });
      console.log(`Sleeping ${config.intervalSeconds.toFixed(2)}s before next experiment window...`);
      await sleep(config.intervalSeconds * 1000);
    }
  }

  const elapsedMinutes = (Date.now() - startedAt) / 60_000;
  appendJsonl(config.logFile, {
    type: "run_completed",
    timestamp: new Date().toISOString(),
    evaluated,
    improvements,
    bestScore: best.score,
    bestHash: best.promptHash,
    elapsedMinutes,
    estimatedCostUsd,
    windowCount: windowIndex,
    budgetExceeded,
  });

  return {
    best,
    evaluated,
    improvements,
    elapsedMinutes,
    estimatedCostUsd,
    windowCount: windowIndex,
  };
}

function enqueueCandidates<TCandidate>(queue: TCandidate[], candidates: TCandidate[]): void {
  for (const candidate of candidates) {
    queue.push(candidate);
  }
}

function appendJsonl(filePath: string, event: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

function normalizeMode(value: string | undefined): AutoresearchMode {
  return value?.trim().toLowerCase() === "fast" ? "fast" : "windowed";
}

function parsePositiveNumber(rawValue: string | undefined, fallback: number): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number, received: ${rawValue}`);
  }
  return value;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received: ${rawValue}`);
  }
  return value;
}

function parseNonNegativeNumber(rawValue: string | undefined, fallback: number): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Expected a non-negative number, received: ${rawValue}`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
