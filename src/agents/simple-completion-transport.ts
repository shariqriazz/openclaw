import { getApiProvider } from "@openclaw/ai/internal/runtime";
/**
 * Simple completion transport preparation.
 *
 * Registers provider-specific stream functions and rewrites models that need OpenClaw-managed transport semantics.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Api, Model } from "../llm/types.js";
import { wrapProviderSimpleCompletionStreamFn } from "../plugins/provider-runtime.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { prepareGoogleSimpleCompletionModel } from "./google-simple-completion-stream.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import {
  buildTransportAwareSimpleStreamFn,
  prepareTransportAwareSimpleModel,
} from "./provider-transport-stream.js";
import type { StreamFn } from "./runtime/index.js";

const PROVIDER_SIMPLE_COMPLETION_API_PREFIX = "openclaw-provider-simple:";

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

function resolveProviderSimpleCompletionApi(model: Model): Api {
  const parts = [model.provider, model.id, model.api, model.baseUrl || "default"];
  return `${PROVIDER_SIMPLE_COMPLETION_API_PREFIX}${parts
    .map((part) => encodeURIComponent(part))
    .join(":")}`;
}

function applyProviderSimpleCompletionWrapper(model: Model, cfg?: OpenClawConfig): Model {
  if (model.api.startsWith(PROVIDER_SIMPLE_COMPLETION_API_PREFIX)) {
    return model;
  }
  const sourceProvider = getApiProvider(model.api);
  if (!sourceProvider) {
    return model;
  }

  const sourceApi = model.api;
  const sourceStreamFn: StreamFn = (runtimeModel, context, options) =>
    sourceProvider.streamSimple({ ...runtimeModel, api: sourceApi }, context, options);
  const streamFn = wrapProviderSimpleCompletionStreamFn({
    provider: model.provider,
    config: cfg,
    context: {
      config: cfg,
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: sourceStreamFn,
    },
  });
  if (!streamFn) {
    return model;
  }

  const api = resolveProviderSimpleCompletionApi(model);
  ensureCustomApiRegistered(api, streamFn);
  return { ...model, api };
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model {
  const { model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (!getApiProvider(model.api) && registerProviderStreamForModel({ model, cfg })) {
    return applyProviderSimpleCompletionWrapper(model, cfg);
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
    if (streamFn) {
      ensureCustomApiRegistered(transportAwareModel.api, streamFn);
      return applyProviderSimpleCompletionWrapper(transportAwareModel, cfg);
    }
  }

  if (model.api === "google-generative-ai") {
    return applyProviderSimpleCompletionWrapper(prepareGoogleSimpleCompletionModel(model), cfg);
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    ensureCustomApiRegistered(api, createAnthropicVertexStreamFnForModel(model));
    return applyProviderSimpleCompletionWrapper({ ...model, api }, cfg);
  }

  return applyProviderSimpleCompletionWrapper(model, cfg);
}
