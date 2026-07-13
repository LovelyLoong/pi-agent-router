import type { AgentRouterConfig, CandidateConfig } from "./schema.js";

type SharedCandidateFields = Pick<
  CandidateConfig,
  | "enabled"
  | "executorId"
  | "capabilities"
  | "allowedTools"
  | "inputModalities"
  | "minimumContextWindow"
  | "allowedSideEffects"
  | "allowedDataSensitivity"
>;

export function createStarterRouterConfig(): AgentRouterConfig {
  const common: SharedCandidateFields = {
    enabled: true,
    executorId: "pi",
    capabilities: ["analysis", "coding", "retrieval", "structured-output"],
    allowedTools: [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "session_search",
      "session_read",
      "provide_results",
    ],
    inputModalities: ["text", "image"],
    minimumContextWindow: 128_000,
    allowedSideEffects: ["none", "read"],
    allowedDataSensitivity: ["public", "internal", "sensitive"],
  };

  return {
    configVersion: 1,
    router: {
      targets: [
        {
          executorId: "pi",
          model: "openai-codex/gpt-5.4-mini",
          thinkingLevel: "low",
        },
        {
          executorId: "pi",
          model: "openai-codex/gpt-5.6-luna",
          thinkingLevel: "low",
        },
      ],
      attemptTimeoutMs: 30_000,
      overallTimeoutMs: 60_000,
    },
    executors: [{ id: "pi", type: "pi-sdk", enabled: true }],
    candidates: [
      {
        ...common,
        id: "codex-mini",
        model: "openai-codex/gpt-5.4-mini",
        allowedThinkingLevels: ["medium", "high"],
        staticPriority: 10,
        metadata: {
          description: "Low-cost general routing target for bounded internal Agent work.",
          strengths: ["fast-analysis", "retrieval", "structured-output"],
          qualityClass: "medium",
          costClass: "low",
          latencyClass: "low",
        },
      },
      {
        ...common,
        id: "codex-luna",
        model: "openai-codex/gpt-5.6-luna",
        allowedThinkingLevels: ["medium", "high"],
        staticPriority: 20,
        metadata: {
          description: "Efficient modern general-purpose target for deeper internal tasks.",
          strengths: ["analysis", "coding", "long-context"],
          qualityClass: "high",
          costClass: "low",
          latencyClass: "medium",
        },
      },
      {
        ...common,
        id: "codex-terra",
        model: "openai-codex/gpt-5.6-terra",
        allowedThinkingLevels: ["high", "xhigh"],
        staticPriority: 30,
        metadata: {
          description: "Balanced high-capability target for complex evidence synthesis and coding.",
          strengths: ["deep-analysis", "coding", "long-context"],
          qualityClass: "high",
          costClass: "medium",
          latencyClass: "high",
        },
      },
      {
        ...common,
        id: "codex-sol",
        model: "openai-codex/gpt-5.6-sol",
        allowedThinkingLevels: ["high", "xhigh"],
        staticPriority: 40,
        metadata: {
          description: "Highest-cost approved V1 target for the hardest bounded tasks.",
          strengths: ["deep-analysis", "architecture", "coding", "long-context"],
          qualityClass: "premium",
          costClass: "premium",
          latencyClass: "premium",
        },
      },
    ],
    execution: {
      attemptTimeoutMs: 180_000,
      overallTimeoutMs: 420_000,
      maxAttempts: 3,
    },
    health: {
      successTtlMs: 900_000,
      failureCooldownMs: 300_000,
      rateLimitCooldownMinMs: 60_000,
      rateLimitCooldownMaxMs: 1_800_000,
    },
    doctor: {
      probeTimeoutMs: 30_000,
      overallTimeoutMs: 180_000,
    },
  };
}
