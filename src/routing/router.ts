import { randomUUID } from "node:crypto";
import type { RouterTargetConfig } from "../config/schema.js";
import type {
  CandidateRanking,
  ExecutionTarget,
  RouteDecision,
  RouteDecisionSource,
} from "../contracts/routing.js";
import type { TaskContract, ThinkingLevel } from "../contracts/task.js";
import type { CandidateRejection, CandidateSnapshot, RoutableCandidate } from "./filter.js";
import { filterCandidates } from "./filter.js";
import {
  buildRouterJudgeInput,
  parseJudgeRanking,
  type RouteJudge,
  type RouterJudgeInput,
} from "./judge.js";

export interface JudgeFailure {
  judgeId: string;
  target: RouterTargetConfig;
  message: string;
}

export interface RoutePlanningResult {
  decision: RouteDecision;
  input: RouterJudgeInput;
  rejections: CandidateRejection[];
  judgeFailures: JudgeFailure[];
}

export class RoutePlanningError extends Error {
  constructor(
    readonly code: "no-routable-candidates" | "invalid-judge-ranking",
    message: string,
    readonly rejections: CandidateRejection[] = [],
  ) {
    super(message);
    this.name = "RoutePlanningError";
  }
}

function executionTarget(
  candidate: RoutableCandidate,
  thinkingLevel: ThinkingLevel,
): ExecutionTarget {
  return {
    candidateId: candidate.candidate.id,
    executorId: candidate.candidate.executorId,
    model: candidate.candidate.model,
    thinkingLevel,
  };
}

function staticRankings(candidates: RoutableCandidate[]): CandidateRanking[] {
  return candidates.map((candidate, index) => ({
    target: executionTarget(candidate, candidate.thinkingLevels[0] as ThinkingLevel),
    rank: index + 1,
    confidence: 0,
    reason: "Configured static fallback priority.",
  }));
}

function judgeRankings(value: unknown, candidates: RoutableCandidate[]): CandidateRanking[] {
  const parsed = parseJudgeRanking(value);
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.candidate.id, candidate]),
  );
  const selected = new Set<string>();
  const rankings: CandidateRanking[] = [];

  for (const item of parsed.rankings) {
    const candidate = candidatesById.get(item.candidateId);
    if (!candidate)
      throw new Error(`Router judge selected unknown candidate '${item.candidateId}'.`);
    if (selected.has(item.candidateId)) {
      throw new Error(`Router judge selected candidate '${item.candidateId}' more than once.`);
    }
    if (!candidate.thinkingLevels.includes(item.thinkingLevel)) {
      throw new Error(
        `Router judge selected unsupported thinking '${item.thinkingLevel}' for '${item.candidateId}'.`,
      );
    }
    selected.add(item.candidateId);
    rankings.push({
      target: executionTarget(candidate, item.thinkingLevel),
      rank: rankings.length + 1,
      confidence: item.confidence,
      reason: item.reason,
    });
  }

  for (const fallback of staticRankings(candidates)) {
    if (selected.has(fallback.target.candidateId)) continue;
    rankings.push({ ...fallback, rank: rankings.length + 1 });
  }
  return rankings;
}

function decision(
  task: TaskContract,
  source: RouteDecisionSource,
  ranked: CandidateRanking[],
): RouteDecision {
  return {
    contractVersion: 1,
    routeId: randomUUID(),
    taskId: task.taskId,
    source,
    ranked,
    decidedAt: new Date().toISOString(),
  };
}

export async function planRoute(options: {
  task: TaskContract;
  snapshots: CandidateSnapshot[];
  judges: RouteJudge[];
  signal?: AbortSignal;
  now?: Date;
}): Promise<RoutePlanningResult> {
  const filtered = filterCandidates(options.task, options.snapshots, options.now);
  if (filtered.candidates.length === 0) {
    throw new RoutePlanningError(
      "no-routable-candidates",
      `No configured candidate can satisfy task '${options.task.taskId}'.`,
      filtered.rejections,
    );
  }

  const input = buildRouterJudgeInput(options.task, filtered.candidates);
  if (filtered.candidates.length === 1 && filtered.candidates[0]?.thinkingLevels.length === 1) {
    return {
      decision: decision(options.task, "single-candidate", staticRankings(filtered.candidates)),
      input,
      rejections: filtered.rejections,
      judgeFailures: [],
    };
  }

  const judgeFailures: JudgeFailure[] = [];
  for (const judge of options.judges) {
    if (options.signal?.aborted) break;
    try {
      const output = await judge.rank(input, options.signal);
      return {
        decision: decision(options.task, "router", judgeRankings(output, filtered.candidates)),
        input,
        rejections: filtered.rejections,
        judgeFailures,
      };
    } catch (error) {
      judgeFailures.push({
        judgeId: judge.id,
        target: judge.target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    decision: decision(options.task, "static-fallback", staticRankings(filtered.candidates)),
    input,
    rejections: filtered.rejections,
    judgeFailures,
  };
}
