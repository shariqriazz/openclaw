// Process-owned bounded queue for trajectory rolling-window worker jobs.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const MAX_QUEUED_TRAJECTORY_BYTES = 64 * 1024 * 1024;
const TRAJECTORY_WORKER_OLD_GENERATION_MIB = 128;
const TRAJECTORY_WORKER_YOUNG_GENERATION_MIB = 16;

type TrajectoryWorkerJob = {
  id: number;
  filePath: string;
  maxFileBytes: number;
  appendedLines: string[];
  queuedBytes: number;
  attempts: number;
  started: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

type TrajectoryWorkerMessage =
  | { type: "ready" }
  | { type: "started"; id: number }
  | { type: "completed"; id: number; bytesWritten: number }
  | { type: "failed"; id: number; error: string }
  | { type: "stopped" };

function resolveTrajectoryRuntimeWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "trajectory", "runtime.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./runtime.worker${extension}`, currentModuleUrl);
}

class TrajectoryRuntimeWorkerQueue {
  private worker: Worker | undefined;
  private workerGeneration = 0;
  private nextId = 0;
  private active: TrajectoryWorkerJob | undefined;
  private readonly queued: TrajectoryWorkerJob[] = [];
  private queuedBytes = 0;
  private readonly capacityWaiters: Array<() => void> = [];

  async replace(params: {
    filePath: string;
    maxFileBytes: number;
    appendedLines: string[];
  }): Promise<void> {
    const queuedBytes = params.appendedLines.reduce(
      (total, line) => total + Buffer.byteLength(line, "utf8"),
      0,
    );
    while (this.queuedBytes > 0 && this.queuedBytes + queuedBytes > MAX_QUEUED_TRAJECTORY_BYTES) {
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    await new Promise<void>((resolve, reject) => {
      this.queued.push({
        ...params,
        id: ++this.nextId,
        queuedBytes,
        attempts: 0,
        started: false,
        resolve,
        reject,
      });
      this.queuedBytes += queuedBytes;
      this.pump();
    });
  }

  describe(): { pendingWrites: number; queuedBytes: number } {
    return {
      pendingWrites: this.queued.length + (this.active ? 1 : 0),
      queuedBytes: this.queuedBytes,
    };
  }

  private createWorker(): Worker {
    const workerUrl = resolveTrajectoryRuntimeWorkerUrl();
    const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts")
      ? ["--import", "tsx"]
      : undefined;
    const worker = new Worker(workerUrl, {
      execArgv: sourceWorkerExecArgv,
      resourceLimits: {
        maxOldGenerationSizeMb: TRAJECTORY_WORKER_OLD_GENERATION_MIB,
        maxYoungGenerationSizeMb: TRAJECTORY_WORKER_YOUNG_GENERATION_MIB,
      },
    });
    worker.unref?.();
    const generation = ++this.workerGeneration;
    worker.on("message", (message: TrajectoryWorkerMessage) => {
      if (generation !== this.workerGeneration) {
        return;
      }
      this.handleMessage(message);
    });
    worker.on("error", () => this.handleWorkerExit(generation));
    worker.on("exit", () => this.handleWorkerExit(generation));
    return worker;
  }

  private pump(): void {
    if (this.active) {
      return;
    }
    const job = this.queued.shift();
    if (!job) {
      return;
    }
    this.active = job;
    try {
      this.worker ??= this.createWorker();
    } catch (error) {
      this.finishActive(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.postActive();
  }

  private postActive(): void {
    const job = this.active;
    if (!job || !this.worker) {
      return;
    }
    this.worker.ref();
    job.attempts += 1;
    job.started = false;
    try {
      this.worker.postMessage({
        type: "replace",
        id: job.id,
        filePath: job.filePath,
        maxFileBytes: job.maxFileBytes,
        appendedLines: job.appendedLines,
        retry: job.attempts > 1,
      });
    } catch {
      this.handleWorkerExit(this.workerGeneration);
    }
  }

  private handleMessage(message: TrajectoryWorkerMessage): void {
    if (message.type === "ready" || message.type === "stopped") {
      return;
    }
    const job = this.active;
    if (!job || message.id !== job.id) {
      return;
    }
    if (message.type === "started") {
      job.started = true;
      return;
    }
    if (message.type === "failed") {
      this.finishActive(new Error(message.error));
      return;
    }
    this.finishActive();
  }

  private finishActive(error?: Error): void {
    const job = this.active;
    if (!job) {
      return;
    }
    this.active = undefined;
    this.worker?.unref();
    this.queuedBytes = Math.max(0, this.queuedBytes - job.queuedBytes);
    if (error) {
      job.reject(error);
    } else {
      job.resolve();
    }
    this.releaseCapacityWaiters();
    this.pump();
  }

  private handleWorkerExit(generation: number): void {
    if (generation !== this.workerGeneration) {
      return;
    }
    this.workerGeneration += 1;
    this.worker = undefined;
    const job = this.active;
    if (!job) {
      this.pump();
      return;
    }
    if (job.attempts >= 2) {
      this.finishActive(new Error("trajectory runtime worker exited during file replacement"));
      return;
    }
    try {
      this.worker = this.createWorker();
    } catch (error) {
      this.finishActive(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.postActive();
  }

  private releaseCapacityWaiters(): void {
    for (const resolve of this.capacityWaiters.splice(0)) {
      resolve();
    }
  }
}

const trajectoryRuntimeWorkerQueue = new TrajectoryRuntimeWorkerQueue();

export async function replaceTrajectoryWindowWithWorker(params: {
  filePath: string;
  maxFileBytes: number;
  appendedLines: string[];
}): Promise<void> {
  await trajectoryRuntimeWorkerQueue.replace(params);
}

export function describeTrajectoryRuntimeWorker(): {
  pendingWrites: number;
  queuedBytes: number;
} {
  return trajectoryRuntimeWorkerQueue.describe();
}

export const testApi = {
  maxQueuedTrajectoryBytes: MAX_QUEUED_TRAJECTORY_BYTES,
  resolveTrajectoryRuntimeWorkerUrl,
};
