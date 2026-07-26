// Fallback configuration tests pin how embedded runs detect model fallback
// availability from explicit overrides versus normal agent config.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasEmbeddedRunConfiguredModelFallbacks } from "./fallbacks.js";

describe("hasEmbeddedRunConfiguredModelFallbacks", () => {
  it("uses explicit non-empty modelFallbacksOverride as configured", () => {
    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg: {},
        provider: "openai",
        model: "gpt-5.6-sol",
        modelFallbacksOverride: ["openai/gpt-5.4"],
      }),
    ).toBe(true);
  });

  it("treats explicit empty modelFallbacksOverride as disabling fallbacks", () => {
    // An explicit empty override is a caller decision, not a request to fall
    // back to defaults from the persisted OpenClaw config.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    };
    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg,
        provider: "openai",
        model: "gpt-5.6-sol",
        modelFallbacksOverride: [],
      }),
    ).toBe(false);
  });

  it("falls back to normal agent/default model fallback config when no override is provided", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    };
    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg,
        provider: "openai",
        model: "gpt-5.6-sol",
        agentId: "main",
      }),
    ).toBe(true);
  });

  it("ignores duplicate fallbacks that resolve to the active model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.6-sol",
            fallbacks: ["openai/gpt-5.6-sol", "openai/gpt-5.6-sol", "openai/gpt-5.6-sol"],
          },
        },
      },
    };

    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg,
        provider: "openai",
        model: "gpt-5.6-sol",
        agentId: "main",
      }),
    ).toBe(false);
  });

  it("keeps a distinct effective fallback after duplicate primary entries", () => {
    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg: {},
        provider: "openai",
        model: "gpt-5.6-sol",
        modelFallbacksOverride: ["openai/gpt-5.6-sol", "openai/gpt-5.4", "openai/gpt-5.4"],
      }),
    ).toBe(true);
  });
});
