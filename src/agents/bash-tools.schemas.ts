/**
 * TypeBox schemas for shell/process tools exposed to model providers.
 *
 * Keep these schemas provider-friendly: flat fields, string enums, and explicit
 * descriptions that match runtime validation.
 */
import { Type } from "typebox";
import { optionalStringEnum } from "./schema/typebox.js";

const EXEC_TOOL_HOST_VALUES = ["auto", "sandbox", "gateway", "node"] as const;
type ExecToolHostValue = (typeof EXEC_TOOL_HOST_VALUES)[number];

/** Resolve only host choices that this tool instance can intentionally route. */
export function resolveExecSchemaHostValues(params?: {
  configuredHost?: ExecToolHostValue;
  sandboxAvailable?: boolean;
  configuredNode?: string;
}): readonly ExecToolHostValue[] {
  const configuredHost = params?.configuredHost ?? "auto";
  if (configuredHost === "sandbox") {
    return params?.sandboxAvailable ? ["auto", "sandbox"] : ["auto"];
  }
  if (configuredHost === "gateway") {
    return ["auto", "gateway"];
  }
  if (configuredHost === "node") {
    return ["auto", "node"];
  }
  if (params?.sandboxAvailable) {
    return ["auto", "sandbox"];
  }
  return params?.configuredNode?.trim() ? ["auto", "gateway", "node"] : ["auto", "gateway"];
}

/** Build the parameters accepted by one capability-scoped exec tool instance. */
export function createExecSchema(hostValues: readonly ExecToolHostValue[] = EXEC_TOOL_HOST_VALUES) {
  return Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    workdir: Type.Optional(
      Type.String({
        description:
          "Working directory. Blank/whitespace values are invalid; omit to use the default cwd.",
      }),
    ),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    yieldMs: Type.Optional(
      Type.Number({
        description: "Milliseconds to wait before backgrounding (default 10000)",
      }),
    ),
    background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
    timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds (optional, kills process on expiry)",
      }),
    ),
    pty: Type.Optional(
      Type.Boolean({
        description:
          "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
      }),
    ),
    elevated: Type.Optional(
      Type.Boolean({
        description: "Run on the host with elevated permissions (if allowed)",
      }),
    ),
    host: optionalStringEnum(hostValues, {
      description: `Exec host/target (${hostValues.join("|")}).`,
    }),
    security: Type.Optional(
      Type.String({
        description:
          "Ignored for normal calls; exec security is set by tools.exec.security and host approvals.",
      }),
    ),
    ask: Type.Optional(
      Type.String({
        description:
          "Baseline ask comes from tools.exec.ask and host approvals; channel-origin calls ignore per-call ask when effective host ask is off.",
      }),
    ),
    node: Type.Optional(
      Type.String({
        description: "Node id/name for host=node.",
      }),
    ),
  });
}

/** Full compatibility schema for callers without session capability context. */
export const execSchema = createExecSchema();

/** Parameters accepted by the process-control tool. */
export const processSchema = Type.Object({
  action: Type.String({
    description: "Process action (list|poll|log|write|send-keys|submit|paste|kill|clear|remove)",
  }),
  sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list" })),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  hex: Type.Optional(Type.Array(Type.String(), { description: "Hex bytes to send for send-keys" })),
  literal: Type.Optional(Type.String({ description: "Literal string for send-keys" })),
  text: Type.Optional(Type.String({ description: "Text to paste for paste" })),
  bracketed: Type.Optional(Type.Boolean({ description: "Wrap paste in bracketed mode" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
  timeout: Type.Optional(
    Type.Number({
      description:
        "For poll: wait up to this many milliseconds before returning; max 30000 ms, higher values are clamped to 30000",
      minimum: 0,
    }),
  ),
});
