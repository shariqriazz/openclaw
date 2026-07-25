// Serial worker entrypoint for trajectory rolling-window persistence.
import { parentPort } from "node:worker_threads";
import { replaceTrajectoryWindowInWorker } from "./runtime-window.js";

type TrajectoryWorkerRequest =
  | {
      type: "replace";
      id: number;
      filePath: string;
      maxFileBytes: number;
      appendedLines: string[];
      retry: boolean;
    }
  | { type: "stop" };

if (!parentPort) {
  throw new Error("trajectory runtime worker requires a parent port");
}
const port = parentPort;
let queue = Promise.resolve();

port.postMessage({ type: "ready" });
port.on("message", (message: TrajectoryWorkerRequest) => {
  if (message.type === "stop") {
    queue = queue.finally(() => {
      port.postMessage({ type: "stopped" });
      port.close();
    });
    return;
  }
  queue = queue
    .then(async () => {
      port.postMessage({ type: "started", id: message.id });
      const result = await replaceTrajectoryWindowInWorker(message);
      port.postMessage({ type: "completed", id: message.id, ...result });
    })
    .catch((error) => {
      port.postMessage({
        type: "failed",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});
