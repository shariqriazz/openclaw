import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceTrajectoryWindowInWorker } from "./runtime-window.js";

const tempDirs: string[] = [];

function makeTempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-window-"));
  tempDirs.push(dir);
  return path.join(dir, "session.trajectory.jsonl");
}

function eventLine(params: { marker: string; ts: string; seq: number }): string {
  return `${JSON.stringify({
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    type: "tool_result",
    ...params,
  })}\n`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("trajectory runtime window worker", () => {
  it("preserves stable ordering and normalizes the existing JSONL window", async () => {
    const filePath = makeTempFile();
    const first = eventLine({ marker: "first", ts: "2026-01-01T00:00:00.000Z", seq: 1 });
    const sameKeyExisting = eventLine({
      marker: "same-existing",
      ts: "2026-01-01T00:00:01.000Z",
      seq: 2,
    });
    const sameKeyIncoming = eventLine({
      marker: "same-incoming",
      ts: "2026-01-01T00:00:01.000Z",
      seq: 2,
    });
    const last = eventLine({ marker: "last", ts: "2026-01-01T00:00:03.000Z", seq: 3 });
    fs.writeFileSync(filePath, `${sameKeyExisting.trimEnd()}\r\n\n${last}`);

    await replaceTrajectoryWindowInWorker({
      filePath,
      maxFileBytes: 64 * 1024,
      appendedLines: [sameKeyIncoming, first],
      retry: false,
    });

    expect(fs.readFileSync(filePath, "utf8")).toBe(
      `${first}${sameKeyExisting}${sameKeyIncoming}${last}`,
    );
  });

  it("makes a retried replacement idempotent without removing legitimate duplicates", async () => {
    const filePath = makeTempFile();
    const line = eventLine({ marker: "duplicate", ts: "2026-01-01T00:00:00.000Z", seq: 1 });

    await replaceTrajectoryWindowInWorker({
      filePath,
      maxFileBytes: 64 * 1024,
      appendedLines: [line, line],
      retry: false,
    });
    const firstWrite = fs.readFileSync(filePath, "utf8");
    expect(firstWrite).toBe(`${line}${line}`);

    await replaceTrajectoryWindowInWorker({
      filePath,
      maxFileBytes: 64 * 1024,
      appendedLines: [line, line],
      retry: true,
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe(firstWrite);
  });

  it("drops complete oldest rows until the rolling window fits", async () => {
    const filePath = makeTempFile();
    const lines = Array.from({ length: 8 }, (_, index) =>
      eventLine({
        marker: `row-${index}`,
        ts: `2026-01-01T00:00:0${index}.000Z`,
        seq: index,
      }),
    );
    fs.writeFileSync(filePath, lines.slice(0, 7).join(""));
    const maxFileBytes = Buffer.byteLength(lines.slice(5).join(""), "utf8");

    await replaceTrajectoryWindowInWorker({
      filePath,
      maxFileBytes,
      appendedLines: [lines[7]!],
      retry: false,
    });

    const output = fs.readFileSync(filePath, "utf8");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(maxFileBytes);
    expect(output).toBe(lines.slice(5).join(""));
  });
});
