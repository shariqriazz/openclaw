import type { AgentEventPayload } from "openclaw/plugin-sdk/agent-harness-runtime";
// Discord plugin module streams bound subagent sessions through the normal draft compositor.
import {
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLineInput,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type {
  PluginHookMessageContext,
  PluginHookMessageSentEvent,
  PluginHookSubagentEndedEvent,
} from "openclaw/plugin-sdk/types";
import { resolveDiscordAccount, resolveDiscordMaxLinesPerMessage } from "./accounts.js";
import { createDiscordRestClient } from "./client.js";
import { createDiscordDraftPreviewController } from "./monitor/message-handler.draft-preview.js";
import { listThreadBindingsBySessionKey } from "./monitor/thread-bindings.js";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

type DraftController = ReturnType<typeof createDiscordDraftPreviewController>;

type StreamState = {
  runId: string;
  controller: DraftController;
  streamingEntry: ReturnType<typeof resolveDiscordAccount>["config"];
};

type DiscordSubagentStreamingDeps = {
  listBindings: typeof listThreadBindingsBySessionKey;
  createController: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    channelId: string;
  }) => DraftController;
  resolveStreamingEntry: (
    cfg: OpenClawConfig,
    accountId: string,
  ) => ReturnType<typeof resolveDiscordAccount>["config"];
  log: (message: string) => void;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}

function progressInputForEvent(
  event: AgentEventPayload,
): ChannelProgressDraftLineInput | undefined {
  const data = event.data;
  if (event.stream === "item") {
    return {
      event: "item",
      itemId: asString(data.itemId),
      toolCallId: asString(data.toolCallId),
      itemKind: asString(data.kind),
      title: asString(data.title),
      name: asString(data.name),
      phase: asString(data.phase),
      status: asString(data.status),
      summary: asString(data.summary),
      progressText: asString(data.progressText),
      meta: asString(data.meta),
    };
  }
  if (event.stream === "plan") {
    return {
      event: "plan",
      phase: asString(data.phase),
      title: asString(data.title),
      explanation: asString(data.explanation),
      steps: asStringArray(data.steps),
    };
  }
  if (event.stream === "approval") {
    return {
      event: "approval",
      phase: asString(data.phase),
      title: asString(data.title),
      command: asString(data.command),
      reason: asString(data.reason),
      message: asString(data.message),
    };
  }
  if (event.stream === "command_output") {
    return {
      event: "command-output",
      itemId: asString(data.itemId),
      toolCallId: asString(data.toolCallId),
      phase: asString(data.phase),
      title: asString(data.title),
      name: asString(data.name),
      status: asString(data.status),
      exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
    };
  }
  if (event.stream === "patch") {
    return {
      event: "patch",
      itemId: asString(data.itemId),
      toolCallId: asString(data.toolCallId),
      phase: asString(data.phase),
      title: asString(data.title),
      name: asString(data.name),
      added: asStringArray(data.added),
      modified: asStringArray(data.modified),
      deleted: asStringArray(data.deleted),
      summary: asString(data.summary),
    };
  }
  return undefined;
}

function createDefaultController(params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
}): DraftController {
  const account = resolveDiscordAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const discordConfig = account.config;
  return createDiscordDraftPreviewController({
    cfg: params.cfg,
    discordConfig,
    accountId: account.accountId,
    sourceRepliesAreToolOnly: false,
    textLimit: discordConfig.textChunkLimit ?? 2000,
    deliveryRest: createDiscordRestClient({
      cfg: params.cfg,
      accountId: account.accountId,
    }).rest,
    deliverChannelId: params.channelId,
    replyReference: { peek: () => undefined },
    tableMode: resolveMarkdownTableMode({
      cfg: params.cfg,
      channel: "discord",
      accountId: account.accountId,
    }),
    maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
      cfg: params.cfg,
      discordConfig,
      accountId: account.accountId,
    }),
    chunkMode: resolveChunkMode(params.cfg, "discord", account.accountId),
    log: logVerbose,
  });
}

export function createDiscordSubagentStreamingCoordinator(
  deps: DiscordSubagentStreamingDeps = {
    listBindings: listThreadBindingsBySessionKey,
    createController: createDefaultController,
    resolveStreamingEntry: (cfg, accountId) =>
      resolveDiscordAccount({
        cfg,
        accountId,
      }).config,
    log: logVerbose,
  },
) {
  const states = new Map<string, StreamState>();
  const queues = new Map<string, Promise<void>>();

  const enqueue = (sessionKey: string, work: () => Promise<void> | void) => {
    const previous = queues.get(sessionKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => {
        deps.log(`discord: subagent stream relay failed: ${String(error)}`);
      })
      .finally(() => {
        if (queues.get(sessionKey) === next) {
          queues.delete(sessionKey);
        }
      });
    queues.set(sessionKey, next);
    return next;
  };

  const finish = async (
    sessionKey: string,
    options: { preserveDraft: boolean; runId?: string },
  ) => {
    const state = states.get(sessionKey);
    if (!state || (options.runId && state.runId !== options.runId)) {
      return;
    }
    states.delete(sessionKey);
    if (options.preserveDraft) {
      state.controller.markPreviewFinalized();
      state.controller.markFinalReplyDelivered();
      await state.controller.flush();
    } else if (state.controller.draftStream?.messageId()) {
      await state.controller.draftStream.deleteCurrentMessage();
    }
    await state.controller.cleanup();
  };

  const resolveState = async (
    cfg: OpenClawConfig,
    sessionKey: string,
    runId: string,
  ): Promise<StreamState | undefined> => {
    const current = states.get(sessionKey);
    if (current?.runId === runId) {
      return current;
    }
    if (current) {
      await finish(sessionKey, { preserveDraft: false, runId: current.runId });
    }
    const bindings = deps.listBindings({
      targetSessionKey: sessionKey,
      targetKind: "subagent",
    });
    if (bindings.length !== 1) {
      return undefined;
    }
    const binding = bindings[0];
    const streamingEntry = deps.resolveStreamingEntry(cfg, binding.accountId);
    if (resolveDiscordPreviewStreamMode(streamingEntry) === "off") {
      return undefined;
    }
    const state = {
      runId,
      streamingEntry,
      controller: deps.createController({
        cfg,
        accountId: binding.accountId,
        channelId: binding.threadId,
      }),
    };
    states.set(sessionKey, state);
    return state;
  };

  return {
    handleAgentEvent(cfg: OpenClawConfig, event: AgentEventPayload) {
      const sessionKey = event.sessionKey;
      if (!sessionKey) {
        return;
      }
      return enqueue(sessionKey, async () => {
        const state = await resolveState(cfg, sessionKey, event.runId);
        if (!state) {
          return;
        }
        if (event.stream === "assistant") {
          state.controller.updateFromPartial(asString(event.data.text));
          return;
        }
        if (event.stream === "thinking") {
          await state.controller.pushReasoningProgress(asString(event.data.text), {
            snapshot: true,
          });
          return;
        }
        if (event.stream === "commentary") {
          await state.controller.pushCommentaryProgress(asString(event.data.text), {
            itemId: asString(event.data.itemId),
          });
          return;
        }
        const input = progressInputForEvent(event);
        if (!input) {
          return;
        }
        const line = buildChannelProgressDraftLineForEntry(state.streamingEntry, input);
        await state.controller.pushToolProgress(line, {
          toolName: "name" in input ? input.name : undefined,
        });
      });
    },
    handleMessageSent(event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      if (ctx.channelId !== "discord" || !sessionKey) {
        return;
      }
      return enqueue(sessionKey, () =>
        finish(sessionKey, {
          preserveDraft: event.success !== true,
          runId: event.runId,
        }),
      );
    },
    handleSubagentEnded(event: PluginHookSubagentEndedEvent) {
      return enqueue(event.targetSessionKey, () =>
        finish(event.targetSessionKey, {
          preserveDraft: event.outcome === "ok",
          runId: event.runId,
        }),
      );
    },
    resetForTests() {
      states.clear();
      queues.clear();
    },
  };
}

export const discordSubagentStreamingCoordinator = createDiscordSubagentStreamingCoordinator();
