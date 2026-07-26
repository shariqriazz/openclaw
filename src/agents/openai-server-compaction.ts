import os from "node:os";
import type { Context, Model } from "@openclaw/ai";
import {
  convertResponsesMessages,
  extractOpenAICodexAccountId,
} from "@openclaw/ai/internal/openai";
import { createAbortError, mergeAbortSignals } from "../infra/abort-signal.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ToolInfo } from "./sessions/index.js";

type JsonRecord = Record<string, unknown>;

export type OpenAIServerCompactionDetails = {
  version: 1;
  provider: "openai-responses-compaction";
  modelKey: string;
  replacementHistory: JsonRecord[];
};

export type OpenAIServerCompactionState = OpenAIServerCompactionDetails & {
  explicitHistory: JsonRecord[];
};

export type OpenAIRequestShape = {
  reasoning?: JsonRecord;
  text?: JsonRecord;
};

const COMPACTION_FEATURE = "remote_compaction_v2";
const RETAINED_USER_TOKENS = 20_000;
const FIRST_RESPONSE_BYTES_TIMEOUT_MS = 120_000;
const RESPONSE_IDLE_TIMEOUT_MS = 60_000;
const RESPONSE_OVERALL_TIMEOUT_MS = 180_000;
const RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return structuredClone(value);
}

function modelKey(model: Pick<Model, "provider" | "api" | "id">): string {
  return `${model.provider}:${model.api}:${model.id}`;
}

export function supportsOpenAIServerCompaction(model: Pick<Model, "provider" | "api">): boolean {
  return (
    model.provider === "openai" &&
    (model.api === "openai-chatgpt-responses" || model.api === "openai-responses")
  );
}

export function matchesOpenAIServerCompactionState(
  state: OpenAIServerCompactionState,
  model: Pick<Model, "provider" | "api" | "id">,
): boolean {
  return state.modelKey === modelKey(model);
}

function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl?.trim() || fallback).replace(/\/+$/, "");
}

function resolveEndpoint(model: Model): string {
  if (model.api === "openai-chatgpt-responses") {
    const baseUrl = normalizeBaseUrl(model.baseUrl, "https://chatgpt.com/backend-api/codex");
    return baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
  }
  const baseUrl = normalizeBaseUrl(model.baseUrl, "https://api.openai.com/v1");
  if (baseUrl.endsWith("/responses")) {
    return baseUrl;
  }
  return baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
}

function mergeCompactionFeature(headers: Headers): void {
  const current = headers
    .get("x-codex-beta-features")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  headers.set(
    "x-codex-beta-features",
    [...new Set([...(current ?? []), COMPACTION_FEATURE])].join(","),
  );
}

function buildHeaders(params: {
  model: Model;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId: string;
}): Headers {
  const headers = new Headers(params.model.headers);
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    headers.set(key, value);
  }
  headers.set("authorization", `Bearer ${params.apiKey}`);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("session_id", params.sessionId);
  headers.set("x-client-request-id", params.sessionId);
  mergeCompactionFeature(headers);

  if (params.model.api === "openai-chatgpt-responses") {
    headers.set("chatgpt-account-id", extractOpenAICodexAccountId(params.apiKey));
    headers.set("originator", "openclaw");
    headers.set("user-agent", `openclaw (${os.platform()} ${os.release()}; ${os.arch()})`);
    headers.set("OpenAI-Beta", "responses=experimental");
  }
  return headers;
}

function convertTools(allTools: ToolInfo[], activeToolNames: string[]): JsonRecord[] {
  const active = new Set(activeToolNames);
  return allTools
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function convertMessages(model: Model, messages: AgentMessage[]): JsonRecord[] {
  const isChatGptTransport = model.api === "openai-chatgpt-responses";
  return convertResponsesMessages(
    model,
    { messages: messages as unknown as Context["messages"], systemPrompt: "" },
    new Set([model.provider]),
    {
      includeSystemPrompt: false,
      replayEncryptedReasoning: !isChatGptTransport,
      replayResponsesItemIds: !isChatGptTransport,
    },
  ) as unknown as JsonRecord[];
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createAbortError("OpenAI server compaction aborted");
}

function scheduleAbort(
  controller: AbortController,
  timeoutMs: number,
  message: string,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    controller.abort(createAbortError(message));
  }, timeoutMs);
  timer.unref?.();
  return timer;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw abortErrorFromSignal(signal);
  }
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortErrorFromSignal(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function parseSseBlock(block: string): unknown | "done" | undefined {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) {
    return undefined;
  }
  if (data === "[DONE]") {
    return "done";
  }
  try {
    return JSON.parse(data) as unknown;
  } catch (cause) {
    throw new Error("OpenAI server compaction returned invalid SSE JSON", { cause });
  }
}

function processCompactionEvent(
  event: unknown,
  compactionItems: JsonRecord[],
): JsonRecord | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  if (event.type === "error") {
    throw new Error(
      `OpenAI server compaction failed: ${
        typeof event.message === "string" ? event.message : "unknown error"
      }`,
    );
  }
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = response && isRecord(response.error) ? response.error : undefined;
    throw new Error(
      `OpenAI server compaction failed: ${
        typeof error?.message === "string" ? error.message : "response failed"
      }`,
    );
  }
  if (
    event.type === "response.output_item.done" &&
    isRecord(event.item) &&
    event.item.type === "compaction"
  ) {
    compactionItems.push(event.item);
    if (compactionItems.length > 1) {
      throw new Error(
        `OpenAI server compaction returned ${compactionItems.length} compaction items`,
      );
    }
  }
  if (event.type !== "response.completed") {
    return undefined;
  }
  if (compactionItems.length !== 1) {
    throw new Error(`OpenAI server compaction returned ${compactionItems.length} compaction items`);
  }
  return compactionItems[0];
}

async function readCompactionItem(params: {
  response: Response;
  signal: AbortSignal;
  deadlineController: AbortController;
}): Promise<JsonRecord> {
  if (!params.response.body) {
    throw new Error("OpenAI server compaction response had no body");
  }
  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  const compactionItems: JsonRecord[] = [];
  let buffer = "";
  let totalBytes = 0;
  let responseTimer = scheduleAbort(
    params.deadlineController,
    FIRST_RESPONSE_BYTES_TIMEOUT_MS,
    "OpenAI server compaction timed out waiting for response bytes",
  );

  const processBufferedBlocks = (): JsonRecord | undefined => {
    while (true) {
      const boundary = buffer.search(/\r?\n\r?\n/u);
      if (boundary < 0) {
        return undefined;
      }
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + separator.length);
      const event = parseSseBlock(block);
      if (event === "done") {
        throw new Error("OpenAI server compaction stream ended before response.completed");
      }
      const item = processCompactionEvent(event, compactionItems);
      if (item) {
        return item;
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, params.signal);
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const event = parseSseBlock(buffer);
          if (event !== "done") {
            const item = processCompactionEvent(event, compactionItems);
            if (item) {
              return item;
            }
          }
        }
        throw new Error("OpenAI server compaction stream ended before response.completed");
      }
      if (!value?.length) {
        continue;
      }
      clearTimeout(responseTimer);
      responseTimer = scheduleAbort(
        params.deadlineController,
        RESPONSE_IDLE_TIMEOUT_MS,
        "OpenAI server compaction response stream became idle",
      );
      totalBytes += value.length;
      if (totalBytes > RESPONSE_MAX_BYTES) {
        throw new Error(`OpenAI server compaction response exceeded ${RESPONSE_MAX_BYTES} bytes`);
      }
      buffer += decoder.decode(value, { stream: true });
      const item = processBufferedBlocks();
      if (item) {
        return item;
      }
    }
  } finally {
    clearTimeout(responseTimer);
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function textFromUserItem(item: JsonRecord): string {
  if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) {
    return "";
  }
  return item.content
    .flatMap((part) =>
      isRecord(part) && part.type === "input_text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}

function retainRecentUserItems(input: JsonRecord[]): JsonRecord[] {
  let remainingChars = RETAINED_USER_TOKENS * 4;
  const retained: JsonRecord[] = [];
  for (const item of input.toReversed()) {
    const text = textFromUserItem(item);
    if (!text || remainingChars <= 0) {
      continue;
    }
    if (text.length <= remainingChars) {
      retained.push(cloneRecord(item));
      remainingChars -= text.length;
      continue;
    }
    retained.push({
      ...cloneRecord(item),
      content: [{ type: "input_text", text: text.slice(0, remainingChars) }],
    });
    remainingChars = 0;
  }
  return retained.toReversed();
}

export async function requestOpenAIServerCompaction(params: {
  model: Model;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId: string;
  messages: AgentMessage[];
  priorState?: OpenAIServerCompactionState;
  systemPrompt: string;
  allTools: ToolInfo[];
  activeToolNames: string[];
  requestShape?: OpenAIRequestShape;
  signal?: AbortSignal;
}): Promise<OpenAIServerCompactionDetails> {
  if (!supportsOpenAIServerCompaction(params.model)) {
    throw new Error("model does not support OpenAI server compaction");
  }
  const input = params.priorState
    ? params.priorState.explicitHistory.map(cloneRecord)
    : convertMessages(params.model, params.messages);
  const deadlineController = new AbortController();
  const overallTimer = scheduleAbort(
    deadlineController,
    RESPONSE_OVERALL_TIMEOUT_MS,
    "OpenAI server compaction exceeded its overall deadline",
  );
  const mergedSignal = mergeAbortSignals([params.signal, deadlineController.signal]);
  const signal = mergedSignal.signal ?? deadlineController.signal;
  try {
    if (signal.aborted) {
      throw abortErrorFromSignal(signal);
    }
    const response = await fetch(resolveEndpoint(params.model), {
      method: "POST",
      headers: buildHeaders(params),
      body: JSON.stringify({
        model: params.model.id,
        input: [...input, { type: "compaction_trigger" }],
        instructions: params.systemPrompt,
        tools: convertTools(params.allTools, params.activeToolNames),
        parallel_tool_calls: true,
        tool_choice: "auto",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: params.sessionId,
        ...(params.requestShape?.reasoning ? { reasoning: params.requestShape.reasoning } : {}),
        ...(params.requestShape?.text ? { text: params.requestShape.text } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenAI server compaction failed (${response.status}): ${body || response.statusText}`,
      );
    }
    const compactionItem = await readCompactionItem({
      response,
      signal,
      deadlineController,
    });
    return {
      version: 1,
      provider: "openai-responses-compaction",
      modelKey: modelKey(params.model),
      replacementHistory: [...retainRecentUserItems(input), cloneRecord(compactionItem)],
    };
  } finally {
    deadlineController.abort(createAbortError("OpenAI server compaction request finished"));
    clearTimeout(overallTimer);
    mergedSignal.dispose();
  }
}

export function readOpenAIRequestShape(payload: unknown): OpenAIRequestShape | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const reasoning = isRecord(payload.reasoning) ? cloneRecord(payload.reasoning) : undefined;
  const text = isRecord(payload.text) ? cloneRecord(payload.text) : undefined;
  return reasoning || text ? { reasoning, text } : undefined;
}

export function patchOpenAIRequestWithCompactedHistory(
  payload: unknown,
  state: OpenAIServerCompactionState,
): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  const next: JsonRecord = { ...payload, input: state.explicitHistory.map(cloneRecord) };
  delete next.previous_response_id;
  return next;
}

export function isOpenAIServerCompactionDetails(
  value: unknown,
): value is OpenAIServerCompactionDetails {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.provider === "openai-responses-compaction" &&
    typeof value.modelKey === "string" &&
    Array.isArray(value.replacementHistory) &&
    value.replacementHistory.every(isRecord)
  );
}

export function hasOpenAIServerCompactionDetails(value: unknown): boolean {
  return isRecord(value) && isOpenAIServerCompactionDetails(value.remoteCompaction);
}

export function findOpenAIServerCompactionState(params: {
  branchEntries: readonly unknown[];
  model: Model;
}): OpenAIServerCompactionState | undefined {
  let compactionIndex = -1;
  let details: OpenAIServerCompactionDetails | undefined;
  for (let index = params.branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = params.branchEntries[index];
    if (!isRecord(entry) || entry.type !== "compaction" || !isRecord(entry.details)) {
      continue;
    }
    const candidate = entry.details.remoteCompaction;
    if (
      isOpenAIServerCompactionDetails(candidate) &&
      candidate.modelKey === modelKey(params.model)
    ) {
      compactionIndex = index;
      details = candidate;
    }
    // A newer compaction boundary supersedes every older provider artifact.
    break;
  }
  if (!details) {
    return undefined;
  }
  const trailingHistory: JsonRecord[] = [];
  let pendingTurn: JsonRecord[] = [];
  for (const entry of params.branchEntries.slice(compactionIndex + 1)) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const message = entry.message as unknown as AgentMessage;
    const items = convertMessages(params.model, [message]);
    if (message.role !== "assistant") {
      pendingTurn.push(...items);
      continue;
    }
    const matchesModel =
      message.provider === params.model.provider &&
      message.api === params.model.api &&
      message.model === params.model.id;
    if (matchesModel) {
      trailingHistory.push(...pendingTurn, ...items);
    }
    pendingTurn = [];
  }
  trailingHistory.push(...pendingTurn);
  return {
    ...details,
    replacementHistory: details.replacementHistory.map(cloneRecord),
    explicitHistory: [...details.replacementHistory.map(cloneRecord), ...trailingHistory],
  };
}

export function appendOpenAIServerCompactionMessage(params: {
  state: OpenAIServerCompactionState;
  model: Model;
  message: AgentMessage;
}): OpenAIServerCompactionState {
  if (
    params.message.role === "assistant" &&
    (params.message.provider !== params.model.provider ||
      params.message.api !== params.model.api ||
      params.message.model !== params.model.id)
  ) {
    return params.state;
  }
  return {
    ...params.state,
    explicitHistory: [
      ...params.state.explicitHistory,
      ...convertMessages(params.model, [params.message]),
    ],
  };
}
