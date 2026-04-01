import { requireOpenClawSdkCore } from "./openclaw-host.js";
import { buildAgentHiFiveChannelPlugin, buildAgentHiFiveSetupPlugin } from "./channels/plugin.js";

const sdk = requireOpenClawSdkCore();
const plugin = buildAgentHiFiveChannelPlugin(sdk);

export default buildAgentHiFiveSetupPlugin(sdk, plugin);
