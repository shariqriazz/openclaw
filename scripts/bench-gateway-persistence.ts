import { spawn } from "node:child_process";
// Standalone Gateway persistence benchmark. All fixtures live under a temporary directory.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { updateSessionStoreEntry } from "../src/config/sessions/store.js";
import { resolveTrajectoryFilePath } from "../src/trajectory/paths.js";
import { createTrajectoryRuntimeRecorder } from "../src/trajectory/runtime.js";

type VariantId =
  | "source"
  | "current"
  | "worker"
  | "parsed-worker"
  | "bounded-worker"
  | "stream-worker"
  | "batch-worker"
  | "sqlite-worker";
type Sample = {
  checkpointMs: number;
  eventLoopP99Ms: number;
  fsyncP99Ms: number;
  heartbeatP99Ms: number;
  heapDeltaMiB: number;
  logicalWriteMiB: number;
  opsPerSecond: number;
  peakRssDeltaMiB: number;
  physicalWriteMiB: number;
  queueWaitP99Ms: number;
  sqliteTxnP99Ms: number;
  walGrowthMiB: number;
};

const MIB = 1024 * 1024;
const profile = process.argv.includes("--smoke")
  ? { entries: 96, entryBytes: 10_000, maxTrajectoryBytes: 1 * MIB, operations: 16 }
  : { entries: 504, entryBytes: 20_000, maxTrajectoryBytes: 10 * MIB, operations: 48 };
const repetitionsArg = process.argv.find((arg) => arg.startsWith("--repetitions="));
const repetitions = Math.max(1, Number(repetitionsArg?.split("=")[1] ?? 5));
const concurrency = 16;
const allVariants: VariantId[] = [
  "source",
  "current",
  "worker",
  "parsed-worker",
  "bounded-worker",
  "stream-worker",
  "batch-worker",
  "sqlite-worker",
];
const variantsArg = process.argv.find((arg) => arg.startsWith("--variants="));
const requestedVariants = variantsArg
  ?.slice("--variants=".length)
  .split(",")
  .filter((variant): variant is VariantId => allVariants.includes(variant as VariantId));
const variants =
  requestedVariants && requestedVariants.length > 0 ? requestedVariants : allVariants;

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function createEntries() {
  return Object.fromEntries(
    Array.from({ length: profile.entries }, (_, index) => [
      `agent:bench:subagent:${index}`,
      {
        sessionId: `session-${index}`,
        sessionFile: `/tmp/bench-session-${index}.jsonl`,
        updatedAt: index,
        label: `bench-${index}`,
        skillsSnapshot: { prompt: "x".repeat(profile.entryBytes) },
      },
    ]),
  );
}

function seedTrajectory(filePath: string) {
  const lineSize = 1024;
  const count = Math.ceil(profile.maxTrajectoryBytes / lineSize);
  const lines = Array.from(
    { length: count },
    (_, index) =>
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "fixture",
        source: "runtime",
        type: "tool_result",
        ts: new Date(1_700_000_000_000 + index).toISOString(),
        seq: index,
        sourceSeq: index,
        sessionId: "fixture",
        data: { text: "x".repeat(800) },
      })}\n`,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join(""));
}

class TrajectoryWorker {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: {
        bytesWritten: number;
        fsyncMs: number;
        operationMs: number;
        queueWaitMs: number;
      }) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly worker: Worker;

  constructor(bounded: boolean) {
    this.worker = new Worker(
      new URL("./lib/gateway-persistence-bench-worker.mjs", import.meta.url),
      {
        resourceLimits: bounded
          ? { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }
          : undefined,
      },
    );
    this.worker.on("message", (message) => {
      const waiter = this.pending.get(message.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        waiter.resolve(message.result);
      } else {
        waiter.reject(new Error(message.error));
      }
    });
  }

  run(job: {
    filePath: string;
    lines: string[];
    maxBytes: number;
    strategy: "sort" | "parse-once" | "merge" | "stream";
  }) {
    const id = ++this.nextId;
    return new Promise<{
      bytesWritten: number;
      fsyncMs: number;
      operationMs: number;
      queueWaitMs: number;
    }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, enqueuedAt: performance.now(), job });
    });
  }

  async close() {
    await this.worker.terminate();
  }
}

function createLine(index: number) {
  return `${JSON.stringify({
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "bench",
    source: "runtime",
    type: "tool_result",
    ts: new Date(1_800_000_000_000 + index).toISOString(),
    seq: index,
    sourceSeq: index,
    sessionId: `session-${index % concurrency}`,
    data: { text: "new result" },
  })}\n`;
}

async function atomicTextWrite(filePath: string, text: string) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tempPath, text);
  const startedAt = performance.now();
  const handle = await fs.promises.open(tempPath, "r");
  await handle.sync();
  await handle.close();
  const fsyncMs = performance.now() - startedAt;
  await fs.promises.rename(tempPath, filePath);
  return { bytes: Buffer.byteLength(text), fsyncMs };
}

async function atomicJsonWrite(filePath: string, value: unknown) {
  return atomicTextWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readProcessWriteBytes(): number {
  try {
    const match = fs.readFileSync("/proc/self/io", "utf8").match(/^write_bytes:\s+(\d+)$/mu);
    return Number(match?.[1] ?? 0);
  } catch {
    return 0;
  }
}

function parseTrajectoryKey(line: string): readonly [number, number] {
  try {
    const event = JSON.parse(line) as { seq?: unknown; sourceSeq?: unknown; ts?: unknown };
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

async function replaceTrajectoryWindow(params: {
  filePath: string;
  lines: string[];
  maxBytes: number;
}) {
  const existing = (await fs.promises.readFile(params.filePath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => `${line}\n`);
  existing.push(...params.lines);
  existing.sort((left, right) => {
    const [leftTs, leftSeq] = parseTrajectoryKey(left);
    const [rightTs, rightSeq] = parseTrajectoryKey(right);
    return leftTs - rightTs || leftSeq - rightSeq;
  });
  let bytes = existing.reduce((total, line) => total + Buffer.byteLength(line), 0);
  while (bytes > params.maxBytes && existing.length > 0) {
    bytes -= Buffer.byteLength(existing.shift() ?? "");
  }
  const result = await atomicTextWrite(params.filePath, existing.join(""));
  return { bytesWritten: bytes, fsyncMs: result.fsyncMs };
}

async function runLimited(tasks: Array<() => Promise<void>>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < tasks.length) {
        const index = next++;
        await tasks[index]?.();
      }
    }),
  );
}

async function runVariant(root: string, variant: VariantId): Promise<Sample> {
  const runRoot = path.join(root, variant);
  fs.mkdirSync(runRoot, { recursive: true });
  const storePath = path.join(runRoot, "sessions.json");
  const entries = createEntries();
  fs.writeFileSync(storePath, `${JSON.stringify(entries, null, 2)}\n`);
  const env = { OPENCLAW_TRAJECTORY: "1", OPENCLAW_STATE_DIR: runRoot };
  const trajectoryPaths = Array.from({ length: concurrency }, (_, index) =>
    resolveTrajectoryFilePath({
      env,
      sessionId: `session-${index}`,
      sessionFile: path.join(runRoot, `session-${index}.jsonl`),
    }),
  );
  for (const filePath of trajectoryPaths) {
    seedTrajectory(filePath);
  }

  const worker =
    variant === "worker" ||
    variant === "parsed-worker" ||
    variant === "bounded-worker" ||
    variant === "stream-worker" ||
    variant === "batch-worker" ||
    variant === "sqlite-worker"
      ? new TrajectoryWorker(
          variant === "bounded-worker" ||
            variant === "stream-worker" ||
            variant === "batch-worker" ||
            variant === "sqlite-worker",
        )
      : undefined;
  const dbPath = path.join(runRoot, "sessions.sqlite");
  const db = variant === "sqlite-worker" ? new DatabaseSync(dbPath) : undefined;
  if (db) {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE sessions (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL);",
    );
    const insert = db.prepare("INSERT INTO sessions(session_key, entry_json) VALUES (?, ?)");
    db.exec("BEGIN");
    for (const [key, entry] of Object.entries(entries)) {
      insert.run(key, JSON.stringify(entry));
    }
    db.exec("COMMIT");
  }

  const eventLoop = monitorEventLoopDelay({ resolution: 1 });
  const heartbeatDrifts: number[] = [];
  let expectedHeartbeat = performance.now() + 10;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    heartbeatDrifts.push(Math.max(0, now - expectedHeartbeat));
    expectedHeartbeat = now + 10;
  }, 10);
  const rssStart = process.memoryUsage().rss;
  const heapStart = process.memoryUsage().heapUsed;
  let peakRss = rssStart;
  let peakHeap = heapStart;
  const memorySampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 5);
  const fsyncSamples: number[] = [];
  const queueWaitSamples: number[] = [];
  const sqliteTxnSamples: number[] = [];
  let logicalBytes = 0;
  const pendingBatch = new Map<string, number>();
  let sessionMutationQueue = Promise.resolve();

  eventLoop.enable();
  const processWriteBytesBefore = readProcessWriteBytes();
  const startedAt = performance.now();
  const tasks = Array.from({ length: profile.operations }, (_, index) => async () => {
    const key = `agent:bench:subagent:${index % profile.entries}`;
    if (variant === "source") {
      await updateSessionStoreEntry({
        storePath,
        sessionKey: key,
        update: () => ({ updatedAt: Date.now() + index }),
        skipMaintenance: true,
      });
      logicalBytes += fs.statSync(storePath).size;
      const sessionId = `session-${index % concurrency}`;
      const recorder = createTrajectoryRuntimeRecorder({
        env,
        sessionId,
        sessionFile: path.join(runRoot, `${sessionId}.jsonl`),
        maxRuntimeFileBytes: profile.maxTrajectoryBytes,
      });
      recorder?.recordEvent("tool_result", { index });
      await recorder?.flush();
      logicalBytes += fs.statSync(recorder!.filePath).size;
      return;
    }

    const queuedAt = performance.now();
    sessionMutationQueue = sessionMutationQueue.then(async () => {
      queueWaitSamples.push(performance.now() - queuedAt);
      if (db) {
        const txnStartedAt = performance.now();
        db.exec("BEGIN IMMEDIATE");
        const row = db
          .prepare("SELECT entry_json FROM sessions WHERE session_key = ?")
          .get(key) as { entry_json: string };
        const entry = JSON.parse(row.entry_json);
        entry.updatedAt = Date.now() + index;
        const json = JSON.stringify(entry);
        db.prepare("UPDATE sessions SET entry_json = ? WHERE session_key = ?").run(json, key);
        db.exec("COMMIT");
        sqliteTxnSamples.push(performance.now() - txnStartedAt);
        logicalBytes += Buffer.byteLength(json);
        return;
      }
      pendingBatch.set(key, Date.now() + index);
      if (variant === "batch-worker" && pendingBatch.size < 8 && index < profile.operations - 1) {
        return;
      }
      const store = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
      for (const [batchKey, updatedAt] of pendingBatch) {
        store[batchKey].updatedAt = updatedAt;
      }
      pendingBatch.clear();
      const result = await atomicJsonWrite(storePath, store);
      logicalBytes += result.bytes;
      fsyncSamples.push(result.fsyncMs);
    });
    await sessionMutationQueue;

    const trajectoryPath = trajectoryPaths[index % concurrency]!;
    if (worker) {
      const result = await worker.run({
        filePath: trajectoryPath,
        lines: [createLine(index)],
        maxBytes: profile.maxTrajectoryBytes,
        strategy:
          variant === "worker"
            ? "sort"
            : variant === "parsed-worker"
              ? "parse-once"
              : variant === "bounded-worker"
                ? "merge"
                : "stream",
      });
      logicalBytes += result.bytesWritten;
      fsyncSamples.push(result.fsyncMs);
      queueWaitSamples.push(result.queueWaitMs);
    } else {
      const result = await replaceTrajectoryWindow({
        filePath: trajectoryPath,
        lines: [createLine(index)],
        maxBytes: profile.maxTrajectoryBytes,
      });
      logicalBytes += result.bytesWritten;
      fsyncSamples.push(result.fsyncMs);
    }
  });
  await runLimited(tasks);
  const elapsedMs = performance.now() - startedAt;
  eventLoop.disable();
  clearInterval(heartbeat);
  clearInterval(memorySampler);
  await worker?.close();
  const walPath = `${dbPath}-wal`;
  const walGrowthMiB = fs.existsSync(walPath) ? fs.statSync(walPath).size / MIB : 0;
  const checkpointStartedAt = performance.now();
  db?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const checkpointMs = db ? performance.now() - checkpointStartedAt : 0;
  db?.close();
  const physicalWriteBytes = Math.max(0, readProcessWriteBytes() - processWriteBytesBefore);

  return {
    checkpointMs,
    eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
    fsyncP99Ms: percentile(fsyncSamples, 0.99),
    heartbeatP99Ms: percentile(heartbeatDrifts, 0.99),
    heapDeltaMiB: (peakHeap - heapStart) / MIB,
    logicalWriteMiB: logicalBytes / MIB,
    opsPerSecond: profile.operations / (elapsedMs / 1000),
    peakRssDeltaMiB: (peakRss - rssStart) / MIB,
    physicalWriteMiB: physicalWriteBytes / MIB,
    queueWaitP99Ms: percentile(queueWaitSamples, 0.99),
    sqliteTxnP99Ms: percentile(sqliteTxnSamples, 0.99),
    walGrowthMiB,
  };
}

async function runVariantInChild(params: { root: string; variant: VariantId }): Promise<Sample> {
  const scriptPath = fileURLToPath(import.meta.url);
  const args = [
    "--import",
    "tsx",
    scriptPath,
    `--child=${params.variant}`,
    `--root=${params.root}`,
    ...(process.argv.includes("--smoke") ? ["--smoke"] : []),
  ];
  return await new Promise<Sample>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`benchmark child ${params.variant} exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(output) as Sample);
      } catch (error) {
        reject(
          new Error(`benchmark child ${params.variant} returned invalid JSON`, { cause: error }),
        );
      }
    });
  });
}

function summarize(samples: Sample[]) {
  const keys = Object.keys(samples[0] ?? {}) as Array<keyof Sample>;
  return Object.fromEntries(
    keys.map((key) => {
      const values = samples.map((sample) => sample[key]);
      const worst = key === "opsPerSecond" ? Math.min(...values) : Math.max(...values);
      return [key, { median: percentile(values, 0.5), worst }];
    }),
  );
}

export async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-persistence-bench-"));
  const results = new Map<VariantId, Sample[]>();
  try {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const variant of variants) {
        const sample = await runVariantInChild({
          root: path.join(root, `run-${repetition}`),
          variant,
        });
        const samples = results.get(variant) ?? [];
        samples.push(sample);
        results.set(variant, samples);
        process.stderr.write(
          `[bench] ${variant} run=${repetition + 1}/${repetitions} ops=${sample.opsPerSecond.toFixed(1)} loopP99=${sample.eventLoopP99Ms.toFixed(1)}ms rss=${sample.peakRssDeltaMiB.toFixed(1)}MiB\n`,
        );
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          profile,
          repetitions,
          concurrency,
          variants: Object.fromEntries(
            variants.map((variant) => [variant, summarize(results.get(variant) ?? [])]),
          ),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const childVariantArg = process.argv.find((arg) => arg.startsWith("--child="));
  const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
  if (childVariantArg && rootArg) {
    const childVariant = childVariantArg.slice("--child=".length) as VariantId;
    if (!allVariants.includes(childVariant)) {
      throw new Error(`unknown benchmark variant: ${childVariant}`);
    }
    const sample = await runVariant(rootArg.slice("--root=".length), childVariant);
    process.stdout.write(`${JSON.stringify(sample)}\n`);
  } else {
    await main();
  }
}
