import {
  appendOpenAIServerCompactionMessage,
  findOpenAIServerCompactionState,
  matchesOpenAIServerCompactionState,
  patchOpenAIRequestWithCompactedHistory,
  readOpenAIRequestShape,
  supportsOpenAIServerCompaction,
  type OpenAIRequestShape,
  type OpenAIServerCompactionState,
} from "../openai-server-compaction.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ExtensionAPI, ExtensionContext } from "../sessions/index.js";

const requestShapes = new WeakMap<object, OpenAIRequestShape>();

export function getOpenAIRequestShape(sessionManager: object): OpenAIRequestShape | undefined {
  return requestShapes.get(sessionManager);
}

export default function openAIServerCompactionExtension(api: ExtensionAPI): void {
  let state: OpenAIServerCompactionState | undefined;

  const syncState = (ctx: ExtensionContext) => {
    const model = ctx.model;
    state =
      model && supportsOpenAIServerCompaction(model)
        ? findOpenAIServerCompactionState({
            branchEntries: ctx.sessionManager.getBranch(),
            model,
          })
        : undefined;
  };

  api.on("session_start", (_event, ctx) => {
    syncState(ctx);
  });
  api.on("session_compact", (_event, ctx) => {
    syncState(ctx);
  });
  api.on("session_before_switch", (_event, ctx) => {
    state = undefined;
    requestShapes.delete(ctx.sessionManager);
  });
  api.on("session_before_fork", (_event, ctx) => {
    state = undefined;
    requestShapes.delete(ctx.sessionManager);
  });
  api.on("session_shutdown", (_event, ctx) => {
    state = undefined;
    requestShapes.delete(ctx.sessionManager);
  });
  api.on("model_select", (_event, ctx) => {
    syncState(ctx);
    requestShapes.delete(ctx.sessionManager);
  });
  api.on("message_end", (event, ctx) => {
    const model = ctx.model;
    if (!state || !model || !supportsOpenAIServerCompaction(model)) {
      return;
    }
    state = appendOpenAIServerCompactionMessage({
      state,
      model,
      message: event.message as AgentMessage,
    });
  });
  api.on("before_provider_request", (event, ctx) => {
    const shape = readOpenAIRequestShape(event.payload);
    if (shape) {
      requestShapes.set(ctx.sessionManager, shape);
    }
    const model = ctx.model;
    if (
      !state ||
      !model ||
      !supportsOpenAIServerCompaction(model) ||
      !matchesOpenAIServerCompactionState(state, model)
    ) {
      return undefined;
    }
    return patchOpenAIRequestWithCompactedHistory(event.payload, state);
  });
}
