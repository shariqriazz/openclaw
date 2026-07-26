/**
 * Reads configured embedded-run model fallback availability.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveRunModelFallbacksOverride } from "../../agent-scope.js";
import { resolveModelCandidateChain } from "../../model-fallback.js";

/**
 * Resolves whether this embedded run has any model fallback path available.
 * Per-run overrides are authoritative so compaction/replay callers can force
 * either a fallback lane or a no-fallback lane independent of agent defaults.
 */
export function hasEmbeddedRunConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string | null;
  sessionKey?: string | null;
  modelFallbacksOverride?: string[];
}): boolean {
  const fallbacksOverride =
    params.modelFallbacksOverride ??
    resolveRunModelFallbacksOverride({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
  return (
    resolveModelCandidateChain({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      fallbacksOverride,
    }).length > 1
  );
}
