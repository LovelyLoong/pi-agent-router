import { defineTool } from "@earendil-works/pi-coding-agent";
import type { RouterTargetConfig } from "../config/schema.js";
import type { ExecutionTarget } from "../contracts/routing.js";
import type { TaskContract } from "../contracts/task.js";
import {
  type JudgeRanking,
  JudgeRankingSchema,
  type RouteJudge,
  type RouterJudgeInput,
} from "../routing/judge.js";
import { createLinkedDeadline, runWithDeadline } from "./deadline.js";
import type { PiSdkExecutionPayload, PiSdkExecutor } from "./pi-sdk.js";

export const ROUTER_SYSTEM_PROMPT = `You are a route-selection judge. Rank only the supplied candidate ids and only one supplied thinking level per candidate. Balance quality, cost, and latency from the task contract. Do not execute the task. Call rank_routes exactly once; never invent a model, executor, candidate, or thinking level.`;

export function routerTask(input: RouterJudgeInput): TaskContract {
  return {
    contractVersion: 1,
    taskId: `route-judge:${input.task.taskId}`.slice(0, 100),
    taskKind: "route-judgment",
    goalSummary: "Rank already-filtered execution candidates for a minimized task contract.",
    requirements: {
      requiredCapabilities: ["analysis", "structured-output"],
      preferredCapabilities: [],
      allowedTools: ["rank_routes"],
      inputModalities: ["text"],
      minimumContextWindow: 1,
      requiresReasoning: true,
      sideEffectClass: "none",
      dataSensitivity: input.task.requirements.dataSensitivity,
      output: { kind: "tool", contractName: "rank_routes.v1" },
    },
    context: input.task.context,
    budget: input.task.budget,
    preferences: input.task.preferences,
  };
}

export class PiSdkRouteJudge implements RouteJudge {
  readonly id: string;
  readonly target: RouterTargetConfig;
  readonly #executor: PiSdkExecutor<JudgeRanking>;
  readonly #cwd: string;
  readonly #timeoutMs: number;

  constructor(options: {
    id: string;
    target: RouterTargetConfig;
    executor: PiSdkExecutor<JudgeRanking>;
    timeoutMs?: number;
    cwd?: string;
  }) {
    this.id = options.id;
    this.target = options.target;
    this.#executor = options.executor;
    this.#cwd = options.cwd ?? process.cwd();
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async rank(input: RouterJudgeInput, signal?: AbortSignal): Promise<unknown> {
    let captured: JudgeRanking | undefined;
    const rankRoutes = defineTool({
      name: "rank_routes",
      label: "Rank configured routes",
      description: "Return the ordered candidate and thinking-level ranking.",
      parameters: JudgeRankingSchema,
      execute: async (_toolCallId, parameters) => {
        captured = parameters;
        return {
          content: [{ type: "text" as const, text: "Route ranking captured." }],
          details: parameters,
          terminate: true,
        };
      },
    });
    const executionTarget: ExecutionTarget = {
      candidateId: `__router__:${this.id}`,
      executorId: this.target.executorId,
      model: this.target.model,
      thinkingLevel: this.target.thinkingLevel,
    };
    const payload: PiSdkExecutionPayload<JudgeRanking> = {
      cwd: this.#cwd,
      prompt: `Rank the configured routes for this minimized input:\n\n${JSON.stringify(input)}`,
      tools: ["rank_routes"],
      customTools: [rankRoutes],
      systemPrompt: ROUTER_SYSTEM_PROMPT,
      captureResult: () => captured,
    };
    const deadline = createLinkedDeadline(signal, this.#timeoutMs, "route");
    const result = await runWithDeadline(
      (attemptSignal) =>
        this.#executor.execute({
          task: routerTask(input),
          target: executionTarget,
          payload,
          signal: attemptSignal,
        }),
      deadline,
    ).finally(() => deadline.dispose());
    if (!result.ok) {
      throw new Error(
        `Router judge '${this.id}' failed (${result.failureClass ?? "unknown"}): ${result.errorMessage ?? "no details"}`,
      );
    }
    return result.result;
  }
}

export function createPiSdkRouteJudges(options: {
  targets: RouterTargetConfig[];
  executor: PiSdkExecutor<JudgeRanking>;
  attemptTimeoutMs: number;
  cwd?: string;
}): PiSdkRouteJudge[] {
  return options.targets.map(
    (target, index) =>
      new PiSdkRouteJudge({
        id: `pi-router-${index + 1}`,
        target,
        executor: options.executor,
        timeoutMs: options.attemptTimeoutMs,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      }),
  );
}
