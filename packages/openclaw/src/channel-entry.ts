import { requireOpenClawSdkCore } from "./openclaw-host.js";
import {
  buildAgentHiFiveChannelPlugin,
  setAgentHiFiveChannelRuntime,
} from "./channels/plugin.js";
import { registerAgentHiFivePlugin } from "./register.js";

const sdk = requireOpenClawSdkCore();
const plugin = buildAgentHiFiveChannelPlugin(sdk);

export default sdk.defineChannelPluginEntry({
  id: "agenthifive",
  name: "AgentHiFive Channels",
  description: "Vault-managed Telegram and Slack channel plugin",
  plugin,
  setRuntime: setAgentHiFiveChannelRuntime,
  registerFull(api) {
    registerAgentHiFivePlugin(api);
  },
});
