import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

function parseKey(line) {
  try {
    const event = JSON.parse(line);
    const ts = typeof event.ts === "string" ? Date.parse(event.ts) : Number.POSITIVE_INFINITY;
    const seq =
      typeof event.sourceSeq === "number"
        ? event.sourceSeq
        : typeof event.seq === "number"
          ? event.seq
          : Number.POSITIVE_INFINITY;
    return [Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY, seq];
  } catch {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
}

function sortLines(lines, strategy) {
  if (strategy === "parse-once") {
    return lines
      .map((line) => ({ key: parseKey(line), line }))
      .sort((left, right) => left.key[0] - right.key[0] || left.key[1] - right.key[1])
      .map((entry) => entry.line);
  }
  return lines.sort((left, right) => {
    const [leftTs, leftSeq] = parseKey(left);
    const [rightTs, rightSeq] = parseKey(right);
    return leftTs - rightTs || leftSeq - rightSeq;
  });
}

function compareKeys(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

function mergeSortedLines(existing, appended) {
  const incoming = appended
    .map((line) => ({ key: parseKey(line), line }))
    .sort((left, right) => compareKeys(left.key, right.key));
  const merged = [];
  let incomingIndex = 0;
  for (const line of existing) {
    const key = parseKey(line);
    while (incomingIndex < incoming.length && compareKeys(incoming[incomingIndex].key, key) < 0) {
      merged.push(incoming[incomingIndex].line);
      incomingIndex += 1;
    }
    merged.push(line);
  }
  while (incomingIndex < incoming.length) {
    merged.push(incoming[incomingIndex].line);
    incomingIndex += 1;
  }
  return merged;
}

function forEachLine(raw, visit) {
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

function replaceWindowStreaming({ filePath, lines: appendedLines, maxBytes }, enqueuedAt) {
  const startedAt = performance.now();
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {}
  const incoming = appendedLines
    .map((line) => ({ key: parseKey(line), line }))
    .sort((left, right) => compareKeys(left.key, right.key));
  let totalBytes = incoming.reduce((total, entry) => total + Buffer.byteLength(entry.line), 0);
  forEachLine(raw, (line) => {
    totalBytes += Buffer.byteLength(line);
  });

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.trajectory-bench-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  const fd = fs.openSync(tempPath, "w", 0o600);
  let bytesToDrop = Math.max(0, totalBytes - maxBytes);
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
  const emit = (line) => {
    const lineBytes = Buffer.byteLength(line);
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
  forEachLine(raw, (line) => {
    const key = parseKey(line);
    while (incomingIndex < incoming.length && compareKeys(incoming[incomingIndex].key, key) < 0) {
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
  const syncStartedAt = performance.now();
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const fsyncMs = performance.now() - syncStartedAt;
  fs.renameSync(tempPath, filePath);
  return {
    bytesWritten,
    fsyncMs,
    operationMs: performance.now() - startedAt,
    queueWaitMs: Math.max(0, startedAt - enqueuedAt),
  };
}

function replaceWindow({ filePath, lines: appendedLines, maxBytes, strategy }, enqueuedAt) {
  if (strategy === "stream") {
    return replaceWindowStreaming({ filePath, lines: appendedLines, maxBytes }, enqueuedAt);
  }
  const startedAt = performance.now();
  let lines = [];
  try {
    lines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => `${line}\n`);
  } catch {}
  if (strategy === "merge") {
    lines = mergeSortedLines(lines, appendedLines);
  } else {
    lines.push(...appendedLines);
    lines = sortLines(lines, strategy);
  }
  let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
  while (bytes > maxBytes && lines.length > 0) {
    bytes -= Buffer.byteLength(lines.shift());
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.trajectory-bench-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  fs.writeFileSync(tempPath, lines.join(""), { encoding: "utf8", mode: 0o600 });
  const syncStartedAt = performance.now();
  const fd = fs.openSync(tempPath, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const fsyncMs = performance.now() - syncStartedAt;
  fs.renameSync(tempPath, filePath);
  return {
    bytesWritten: bytes,
    fsyncMs,
    operationMs: performance.now() - startedAt,
    queueWaitMs: Math.max(0, startedAt - enqueuedAt),
  };
}

parentPort?.on("message", (message) => {
  try {
    parentPort.postMessage({
      id: message.id,
      ok: true,
      result: replaceWindow(message.job, message.enqueuedAt),
    });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
