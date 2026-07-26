import type { Model } from "@openclaw/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findOpenAIServerCompactionState,
  hasOpenAIServerCompactionDetails,
  matchesOpenAIServerCompactionState,
  patchOpenAIRequestWithCompactedHistory,
  requestOpenAIServerCompaction,
} from "./openai-server-compaction.js";
import type { AgentMessage } from "./runtime/index.js";

function buildToken(): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-test",
      },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function buildModel(): Model<"openai-chatgpt-responses"> {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-chatgpt-responses",
    provider: "openai",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  };
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function compactionEvents(encryptedContent = "opaque-test"): string {
  const events = [
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: encryptedContent },
    },
    { type: "response.completed", response: { usage: {} } },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function openStreamResponse(params: { chunks?: string[]; onCancel?: () => void }): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of params.chunks ?? []) {
          controller.enqueue(encoder.encode(chunk));
        }
      },
      cancel() {
        params.onCancel?.();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAI server compaction", () => {
  it("requests a compaction artifact through the existing Responses endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const events = [
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque-test" },
        },
        { type: "response.completed", response: { usage: {} } },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const details = await requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-test",
      messages: [userMessage("remember this", 1)],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
      requestShape: {
        reasoning: { effort: "high", summary: "auto" },
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      reasoning: { effort: "high", summary: "auto" },
    });
    expect((body.input as Array<Record<string, unknown>>).at(-1)).toEqual({
      type: "compaction_trigger",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("account-test");
    expect(headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
    expect(details.replacementHistory.at(-1)).toEqual({
      type: "compaction",
      encrypted_content: "opaque-test",
    });
  });

  it("completes on response.completed without waiting for the SSE connection to close", async () => {
    let canceled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        openStreamResponse({
          chunks: [compactionEvents()],
          onCancel: () => {
            canceled = true;
          },
        }),
      ),
    );

    const details = await requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-open-stream",
      messages: [userMessage("remember this", 1)],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
    });

    expect(details.replacementHistory.at(-1)).toMatchObject({
      type: "compaction",
      encrypted_content: "opaque-test",
    });
    expect(canceled).toBe(true);
  });

  it("does not wait for a non-cooperating stream cancellation after completion", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(compactionEvents()));
            },
            cancel() {
              return new Promise<void>(() => {});
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    await expect(
      requestOpenAIServerCompaction({
        model: buildModel(),
        apiKey: buildToken(),
        sessionId: "session-stuck-cancel",
        messages: [userMessage("remember this", 1)],
        systemPrompt: "system",
        allTools: [],
        activeToolNames: [],
      }),
    ).resolves.toMatchObject({
      provider: "openai-responses-compaction",
    });
  });

  it("times out and cancels a stream that never produces response bytes", async () => {
    vi.useFakeTimers();
    let canceled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        openStreamResponse({
          onCancel: () => {
            canceled = true;
          },
        }),
      ),
    );

    const request = requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-no-bytes",
      messages: [userMessage("remember this", 1)],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
    });
    const rejection = expect(request).rejects.toThrow(
      "OpenAI server compaction timed out waiting for response bytes",
    );
    await vi.advanceTimersByTimeAsync(120_001);

    await rejection;
    expect(canceled).toBe(true);
  });

  it("times out and cancels a stream that becomes idle before completion", async () => {
    vi.useFakeTimers();
    let canceled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        openStreamResponse({
          chunks: ['data: {"type":"response.created"}\n\n'],
          onCancel: () => {
            canceled = true;
          },
        }),
      ),
    );

    const request = requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-idle",
      messages: [userMessage("remember this", 1)],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
    });
    const rejection = expect(request).rejects.toThrow(
      "OpenAI server compaction response stream became idle",
    );
    await vi.advanceTimersByTimeAsync(60_001);

    await rejection;
    expect(canceled).toBe(true);
  });

  it("enforces the overall deadline even when non-terminal bytes keep arriving", async () => {
    vi.useFakeTimers();
    let canceled = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const request = requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-overall-timeout",
      messages: [userMessage("remember this", 1)],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
    });
    const rejection = expect(request).rejects.toThrow(
      "OpenAI server compaction exceeded its overall deadline",
    );
    await vi.advanceTimersByTimeAsync(50_000);
    streamController?.enqueue(encoder.encode(": heartbeat\n\n"));
    await vi.advanceTimersByTimeAsync(50_000);
    streamController?.enqueue(encoder.encode(": heartbeat\n\n"));
    await vi.advanceTimersByTimeAsync(50_000);
    streamController?.enqueue(encoder.encode(": heartbeat\n\n"));
    await vi.advanceTimersByTimeAsync(30_001);

    await rejection;
    expect(canceled).toBe(true);
  });

  it("cancels a pending stream when the owning operation aborts", async () => {
    let canceled = false;
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        openStreamResponse({
          onCancel: () => {
            canceled = true;
          },
        }),
      ),
    );

    const request = requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-aborted",
      messages: [userMessage("remember this", 1)],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
      signal: controller.signal,
    });
    const rejection = expect(request).rejects.toThrow("owner stopped");
    controller.abort(new Error("owner stopped"));

    await rejection;
    expect(canceled).toBe(true);
  });

  it.each([
    {
      name: "malformed JSON",
      body: "data: {not-json}\n\n",
      error: "OpenAI server compaction returned invalid SSE JSON",
    },
    {
      name: "provider failure",
      body: `data: ${JSON.stringify({
        type: "response.failed",
        response: { error: { message: "provider unavailable" } },
      })}\n\n`,
      error: "OpenAI server compaction failed: provider unavailable",
    },
    {
      name: "duplicate compaction items",
      body: `${compactionEvents("first").replace(
        'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "second" },
        })}\n\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n`,
      )}`,
      error: "OpenAI server compaction returned 2 compaction items",
    },
  ])("rejects and cancels $name streams", async ({ body, error }) => {
    let canceled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        openStreamResponse({
          chunks: [body],
          onCancel: () => {
            canceled = true;
          },
        }),
      ),
    );

    await expect(
      requestOpenAIServerCompaction({
        model: buildModel(),
        apiKey: buildToken(),
        sessionId: "session-invalid",
        messages: [userMessage("remember this", 1)],
        systemPrompt: "system",
        allTools: [],
        activeToolNames: [],
      }),
    ).rejects.toThrow(error);
    expect(canceled).toBe(true);
  });

  it("compacts from prior opaque history instead of the portable summary", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const events = [
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque-next" },
        },
        { type: "response.completed", response: { usage: {} } },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-test",
      messages: [userMessage("portable summary that must not replace opaque history", 1)],
      priorState: {
        version: 1,
        provider: "openai-responses-compaction",
        modelKey: "openai:openai-chatgpt-responses:gpt-5.6-sol",
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque-old" }],
        explicitHistory: [
          { type: "compaction", encrypted_content: "opaque-old" },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "new turn" }],
          },
        ],
      },
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input).toEqual([
      { type: "compaction", encrypted_content: "opaque-old" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "new turn" }],
      },
      { type: "compaction_trigger" },
    ]);
  });

  it("preserves ChatGPT store-disabled replay safeguards", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const events = [
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque-next" },
        },
        { type: "response.completed", response: { usage: {} } },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestOpenAIServerCompaction({
      model: buildModel(),
      apiKey: buildToken(),
      sessionId: "session-test",
      messages: [
        {
          role: "assistant",
          api: "openai-chatgpt-responses",
          provider: "openai",
          model: "gpt-5.6-sol",
          content: [
            {
              type: "thinking",
              thinking: "private",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                id: "rs_prior",
                encrypted_content: "ciphertext",
              }),
            },
            {
              type: "text",
              text: "Checking.",
              textSignature: JSON.stringify({
                v: 1,
                id: "msg_prior",
                phase: "commentary",
              }),
            },
          ],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      ],
      systemPrompt: "system",
      allTools: [],
      activeToolNames: [],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input.some((item) => item.type === "reasoning")).toBe(false);
    const message = body.input.find((item) => item.type === "message");
    expect(message).not.toHaveProperty("id");
  });

  it("replays the persisted artifact plus messages written after its boundary", () => {
    const model = buildModel();
    const remoteCompaction = {
      version: 1 as const,
      provider: "openai-responses-compaction" as const,
      modelKey: "openai:openai-chatgpt-responses:gpt-5.6-sol",
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque-test" }],
    };
    const state = findOpenAIServerCompactionState({
      model,
      branchEntries: [
        {
          type: "compaction",
          details: { remoteCompaction },
        },
        {
          type: "message",
          message: userMessage("correction after compaction", 2),
        },
      ],
    });

    expect(state?.explicitHistory).toEqual([
      { type: "compaction", encrypted_content: "opaque-test" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "correction after compaction" }],
      },
    ]);
    expect(
      patchOpenAIRequestWithCompactedHistory(
        {
          model: model.id,
          input: [{ type: "message", role: "user", content: [] }],
          previous_response_id: "response-old",
        },
        state!,
      ),
    ).toEqual({
      model: model.id,
      input: state?.explicitHistory,
    });
  });

  it("drops trailing turns completed by a different model", () => {
    const model = buildModel();
    const state = findOpenAIServerCompactionState({
      model,
      branchEntries: [
        {
          type: "compaction",
          details: {
            remoteCompaction: {
              version: 1,
              provider: "openai-responses-compaction",
              modelKey: "openai:openai-chatgpt-responses:gpt-5.6-sol",
              replacementHistory: [{ type: "compaction", encrypted_content: "opaque-test" }],
            },
          },
        },
        { type: "message", message: userMessage("different model turn", 2) },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "other reply" }],
            provider: "openai",
            api: "openai-chatgpt-responses",
            model: "gpt-5.6-luna",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 3,
          },
        },
      ],
    });

    expect(state?.explicitHistory).toEqual([
      { type: "compaction", encrypted_content: "opaque-test" },
    ]);
    expect(matchesOpenAIServerCompactionState(state!, model)).toBe(true);
    expect(
      hasOpenAIServerCompactionDetails({
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compaction",
          modelKey: "openai:openai-chatgpt-responses:gpt-5.6-sol",
          replacementHistory: [{ type: "compaction", encrypted_content: "opaque-test" }],
        },
      }),
    ).toBe(true);
    expect(
      matchesOpenAIServerCompactionState(state!, {
        ...model,
        id: "gpt-5.6-luna",
      }),
    ).toBe(false);
  });

  it("does not revive an older artifact across a newer model compaction", () => {
    const model = buildModel();
    const state = findOpenAIServerCompactionState({
      model,
      branchEntries: [
        {
          type: "compaction",
          details: {
            remoteCompaction: {
              version: 1,
              provider: "openai-responses-compaction",
              modelKey: "openai:openai-chatgpt-responses:gpt-5.6-sol",
              replacementHistory: [{ type: "compaction", encrypted_content: "opaque-sol" }],
            },
          },
        },
        {
          type: "compaction",
          details: {
            remoteCompaction: {
              version: 1,
              provider: "openai-responses-compaction",
              modelKey: "openai:openai-chatgpt-responses:gpt-5.6-luna",
              replacementHistory: [{ type: "compaction", encrypted_content: "opaque-luna" }],
            },
          },
        },
      ],
    });

    expect(state).toBeUndefined();
  });
});
