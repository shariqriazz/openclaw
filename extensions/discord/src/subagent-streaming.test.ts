import type { AgentEventPayload } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { createDiscordSubagentStreamingCoordinator } from "./subagent-streaming.js";

const cfg = {} as OpenClawConfig;

function createBinding(sessionKey: string, threadId = "thread-1") {
  return {
    accountId: "default",
    channelId: "channel-1",
    threadId,
    targetKind: "subagent" as const,
    targetSessionKey: sessionKey,
    agentId: "main",
    boundBy: "test",
    boundAt: 1,
    lastActivityAt: 1,
  };
}

function createController() {
  const deleteCurrentMessage = vi.fn(async () => {});
  return {
    draftStream: {
      messageId: vi.fn(() => "draft-1"),
      deleteCurrentMessage,
    },
    updateFromPartial: vi.fn(),
    pushReasoningProgress: vi.fn(async () => {}),
    pushCommentaryProgress: vi.fn(async () => {}),
    pushToolProgress: vi.fn(async () => {}),
    markPreviewFinalized: vi.fn(),
    markFinalReplyDelivered: vi.fn(),
    flush: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    deleteCurrentMessage,
  };
}

function createEvent(params: {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: Record<string, unknown>;
}): AgentEventPayload {
  return {
    runId: params.runId ?? "run-1",
    sessionKey: params.sessionKey ?? "agent:main:subagent:child",
    stream: params.stream ?? "assistant",
    seq: 1,
    ts: 1,
    data: params.data ?? { text: "working" },
  };
}

function createHarness(options?: { bound?: boolean; mode?: "off" | "partial" | "progress" }) {
  const controllers: ReturnType<typeof createController>[] = [];
  const sessionKey = "agent:main:subagent:child";
  const coordinator = createDiscordSubagentStreamingCoordinator({
    listBindings: vi.fn(() => (options?.bound === false ? [] : [createBinding(sessionKey)])),
    resolveStreamingEntry: vi.fn(() => ({
      streaming: { mode: options?.mode ?? "partial" },
    })),
    createController: vi.fn(() => {
      const controller = createController();
      controllers.push(controller);
      return controller as never;
    }),
    log: vi.fn(),
  });
  return { controllers, coordinator, sessionKey };
}

describe("Discord thread-bound subagent streaming", () => {
  it("streams assistant text only for an exact bound subagent session", async () => {
    const bound = createHarness();
    await bound.coordinator.handleAgentEvent(cfg, createEvent({}));

    expect(bound.controllers).toHaveLength(1);
    expect(bound.controllers[0].updateFromPartial).toHaveBeenCalledWith("working");

    const unbound = createHarness({ bound: false });
    await unbound.coordinator.handleAgentEvent(cfg, createEvent({}));
    expect(unbound.controllers).toHaveLength(0);
  });

  it("honors disabled Discord streaming", async () => {
    const harness = createHarness({ mode: "off" });
    await harness.coordinator.handleAgentEvent(cfg, createEvent({}));
    expect(harness.controllers).toHaveLength(0);
  });

  it("removes the draft after the final Discord message is delivered", async () => {
    const { controllers, coordinator, sessionKey } = createHarness();
    await coordinator.handleAgentEvent(cfg, createEvent({ sessionKey }));
    await coordinator.handleMessageSent(
      {
        to: "thread-1",
        content: "done",
        success: true,
        runId: "run-1",
        sessionKey,
      },
      { channelId: "discord", sessionKey },
    );

    expect(controllers[0].deleteCurrentMessage).toHaveBeenCalledOnce();
    expect(controllers[0].cleanup).toHaveBeenCalledOnce();
    expect(controllers[0].markPreviewFinalized).not.toHaveBeenCalled();
  });

  it("preserves the latest draft when final Discord delivery fails", async () => {
    const { controllers, coordinator, sessionKey } = createHarness();
    await coordinator.handleAgentEvent(cfg, createEvent({ sessionKey }));
    await coordinator.handleMessageSent(
      {
        to: "thread-1",
        content: "done",
        success: false,
        runId: "run-1",
        sessionKey,
      },
      { channelId: "discord", sessionKey },
    );

    expect(controllers[0].markPreviewFinalized).toHaveBeenCalledOnce();
    expect(controllers[0].markFinalReplyDelivered).toHaveBeenCalledOnce();
    expect(controllers[0].flush).toHaveBeenCalledOnce();
    expect(controllers[0].deleteCurrentMessage).not.toHaveBeenCalled();
  });

  it("cleans a stale draft before a replacement run starts", async () => {
    const { controllers, coordinator, sessionKey } = createHarness();
    await coordinator.handleAgentEvent(cfg, createEvent({ sessionKey, runId: "run-1" }));
    await coordinator.handleAgentEvent(
      cfg,
      createEvent({ sessionKey, runId: "run-2", data: { text: "new run" } }),
    );

    expect(controllers).toHaveLength(2);
    expect(controllers[0].deleteCurrentMessage).toHaveBeenCalledOnce();
    expect(controllers[1].updateFromPartial).toHaveBeenCalledWith("new run");
  });

  it("preserves a successful run draft only when no final delivery consumed it", async () => {
    const { controllers, coordinator, sessionKey } = createHarness();
    await coordinator.handleAgentEvent(cfg, createEvent({ sessionKey }));
    await coordinator.handleSubagentEnded({
      targetSessionKey: sessionKey,
      targetKind: "subagent",
      reason: "completed",
      runId: "run-1",
      outcome: "ok",
    });

    expect(controllers[0].markPreviewFinalized).toHaveBeenCalledOnce();
    expect(controllers[0].flush).toHaveBeenCalledOnce();
  });

  it("removes a failed run draft and keeps sessions isolated", async () => {
    const first = "agent:main:subagent:first";
    const second = "agent:main:subagent:second";
    const controllers: ReturnType<typeof createController>[] = [];
    const coordinator = createDiscordSubagentStreamingCoordinator({
      listBindings: vi.fn(({ targetSessionKey }) => [createBinding(targetSessionKey)]),
      resolveStreamingEntry: vi.fn(() => ({ streaming: { mode: "partial" as const } })),
      createController: vi.fn(() => {
        const controller = createController();
        controllers.push(controller);
        return controller as never;
      }),
      log: vi.fn(),
    });

    await coordinator.handleAgentEvent(cfg, createEvent({ sessionKey: first, runId: "first" }));
    await coordinator.handleAgentEvent(cfg, createEvent({ sessionKey: second, runId: "second" }));
    await coordinator.handleSubagentEnded({
      targetSessionKey: first,
      targetKind: "subagent",
      reason: "failed",
      runId: "first",
      outcome: "error",
    });

    expect(controllers[0].deleteCurrentMessage).toHaveBeenCalledOnce();
    expect(controllers[1].deleteCurrentMessage).not.toHaveBeenCalled();
  });
});
