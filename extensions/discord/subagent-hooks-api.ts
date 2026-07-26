// Discord API module exposes the plugin public contract.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { discordSubagentStreamingCoordinator } from "./src/subagent-streaming.js";

const loadDiscordSubagentHooksModule = createLazyRuntimeModule(
  () => import("./src/subagent-hooks.js"),
);

// Subagent hooks live behind a dedicated barrel so the bundled entry can
// register one stable hook wiring path while keeping the handler module lazy.
export function registerDiscordSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_ended", async (event) => {
    await discordSubagentStreamingCoordinator.handleSubagentEnded(event);
    const { handleDiscordSubagentEnded } = await loadDiscordSubagentHooksModule();
    handleDiscordSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleDiscordSubagentDeliveryTarget } = await loadDiscordSubagentHooksModule();
    return handleDiscordSubagentDeliveryTarget(event);
  });
  api.on("message_sent", async (event, ctx) => {
    await discordSubagentStreamingCoordinator.handleMessageSent(event, ctx);
  });
  api.agent.events.registerAgentEventSubscription({
    id: "thread-bound-subagent-streaming",
    streams: [
      "assistant",
      "thinking",
      "commentary",
      "item",
      "plan",
      "approval",
      "command_output",
      "patch",
    ],
    handle: async (event) => {
      await discordSubagentStreamingCoordinator.handleAgentEvent(api.config, event);
    },
  });
}
