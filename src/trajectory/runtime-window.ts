// Worker-owned trajectory rolling-window replacement.
import fs from "node:fs";
import path from "node:path";
import { assertNoSymlinkParents, writeSiblingTempFile } from "../infra/fs-safe-advanced.js";
import { readRegularFileSync } from "../infra/fs-safe.js";
import { TRAJECTORY_RUNTIME_FILE_MAX_BYTES } from "./paths.js";

type TrajectoryWindowLine = {
  key: readonly [number, number];
  line: string;
};

function parseTrajectoryWindowLine(line: string): readonly [number, number] {
  try {
    const parsed = JSON.parse(line) as { ts?: unknown; sourceSeq?: unknown; seq?: unknown };
    const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.POSITIVE_INFINITY;
    const sourceSeq = typeof parsed.sourceSeq === "number" ? parsed.sourceSeq : undefined;
    const seq = typeof parsed.seq === "number" ? parsed.seq : undefined;
    return [
      Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY,
      sourceSeq ?? seq ?? Number.POSITIVE_INFINITY,
    ];
  } catch {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
}

function compareTrajectoryWindowKeys(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

function forEachTrajectoryLine(raw: string, visit: (line: string) => void): void {
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf("\n", start);
    const end = newline === -1 ? raw.length : newline;
    const valueEnd = end > start && raw[end - 1] === "\r" ? end - 1 : end;
    if (valueEnd > start) {
      visit(`${raw.slice(start, valueEnd)}\n`);
    }
    if (newline === -1) {
      return;
    }
    start = newline + 1;
  }
}

function resolveRetryLines(raw: string, appendedLines: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const line of appendedLines) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  forEachTrajectoryLine(raw, (line) => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
    }
  });
  return appendedLines.filter((line) => {
    const count = remaining.get(line) ?? 0;
    if (count === 0) {
      return false;
    }
    remaining.set(line, count - 1);
    return true;
  });
}

function writeTrajectoryWindow(params: {
  raw: string;
  appendedLines: string[];
  maxFileBytes: number;
  tempPath: string;
}): number {
  const incoming: TrajectoryWindowLine[] = params.appendedLines
    .map((line) => ({ key: parseTrajectoryWindowLine(line), line }))
    .toSorted((left, right) => compareTrajectoryWindowKeys(left.key, right.key));
  let totalBytes = incoming.reduce(
    (total, entry) => total + Buffer.byteLength(entry.line, "utf8"),
    0,
  );
  forEachTrajectoryLine(params.raw, (line) => {
    totalBytes += Buffer.byteLength(line, "utf8");
  });

  const fd = fs.openSync(params.tempPath, "w", 0o600);
  let bytesToDrop = Math.max(0, totalBytes - params.maxFileBytes);
  let bytesWritten = 0;
  let pendingOutput = "";
  let incomingIndex = 0;
  const flushOutput = () => {
    if (pendingOutput.length === 0) {
      return;
    }
    fs.writeSync(fd, pendingOutput);
    pendingOutput = "";
  };
  const emit = (line: string) => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytesToDrop > 0) {
      bytesToDrop -= lineBytes;
      return;
    }
    pendingOutput += line;
    bytesWritten += lineBytes;
    if (pendingOutput.length >= 1024 * 1024) {
      flushOutput();
    }
  };

  try {
    forEachTrajectoryLine(params.raw, (line) => {
      const key = parseTrajectoryWindowLine(line);
      while (
        incomingIndex < incoming.length &&
        compareTrajectoryWindowKeys(incoming[incomingIndex].key, key) < 0
      ) {
        emit(incoming[incomingIndex].line);
        incomingIndex += 1;
      }
      emit(line);
    });
    while (incomingIndex < incoming.length) {
      emit(incoming[incomingIndex].line);
      incomingIndex += 1;
    }
    flushOutput();
  } finally {
    fs.closeSync(fd);
  }
  return bytesWritten;
}

export async function replaceTrajectoryWindowInWorker(params: {
  filePath: string;
  maxFileBytes: number;
  appendedLines: string[];
  retry: boolean;
}): Promise<{ bytesWritten: number }> {
  const dir = path.dirname(params.filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkParents({
    rootDir: path.parse(path.resolve(dir)).root,
    targetPath: path.resolve(dir),
    allowMissing: false,
    allowRootChildSymlink: true,
    requireDirectories: true,
    messagePrefix: "Refusing to write trajectory under",
  });
  let raw = "";
  try {
    raw = readRegularFileSync({
      filePath: params.filePath,
      maxBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
    }).buffer.toString("utf8");
  } catch {
    // A missing or unreadable prior window starts from an empty trajectory.
  }
  const appendedLines = params.retry
    ? resolveRetryLines(raw, params.appendedLines)
    : params.appendedLines;
  let bytesWritten = 0;
  await writeSiblingTempFile({
    dir,
    chmodDir: false,
    mode: 0o600,
    tempPrefix: ".openclaw-trajectory-",
    writeTemp: async (tempPath) => {
      bytesWritten = writeTrajectoryWindow({
        raw,
        appendedLines,
        maxFileBytes: params.maxFileBytes,
        tempPath,
      });
    },
    resolveFinalPath: () => params.filePath,
  });
  return { bytesWritten };
}
