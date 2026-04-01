// OpenClaw plugin entry (register-based API for OpenClaw's plugin loader)
export { default as plugin } from "./register.js";
export {
  checkPendingChannelApprovals,
  startChannelApprovalWatcher,
} from "./channels/approval-watcher.js";
export {
  addChannelLifecycleEvent,
  initChannelLifecycleEvents,
  consumeChannelLifecycleEvents,
  loadChannelLifecycleEvents,
  saveChannelLifecycleEvents,
} from "./channels/lifecycle-events.js";
export { consumeChannelLifecycleContext } from "./channels/lifecycle-context.js";
export {
  buildTelegramCompletionRequest,
  completeTelegramPendingAction,
} from "./channels/telegram-outbound.js";
export {
  buildSlackCompletionRequest,
  completeSlackPendingAction,
} from "./channels/slack-outbound.js";
export {
  adaptChannelActionResponse,
  channelActionApprovalRequired,
  channelActionBlocked,
  channelActionFailed,
  channelActionSent,
} from "./channels/outbound.js";
export {
  addPendingChannelAction,
  getPendingChannelAction,
  initPendingChannelActions,
  loadPendingChannelActions,
  removePendingChannelAction,
  savePendingChannelActions,
  updatePendingChannelActionStatus,
} from "./channels/pending-actions.js";
export { createTelegramChannelRuntime } from "./channels/channel.js";
export { createSlackChannelRuntime } from "./channels/slack-runtime.js";
export {
  buildSlackInboundPollerOpts,
  buildTelegramInboundPollerOpts,
  handleSlackInboundMessage,
  handleTelegramInboundMessage,
  startSlackInboundGateway,
  startTelegramInboundGateway,
} from "./channels/inbound.js";
export { normalizeTelegramInboundEvent } from "./channels/telegram.js";
export { normalizeSlackInboundEvent } from "./channels/slack.js";

// Prompt reference (for LLM-as-integration-layer)
export {
  API_REFERENCE_PROMPT,
  API_REFERENCE_SECTIONS,
  CHUNKED_API_SECTIONS,
  buildApiReferencePrompt,
  writeReferenceFiles,
  buildChunkedPrompt,
} from "./prompt-reference.js";

// Client
export { VaultClient, VaultApiError } from "./client.js";

// JWT utilities
export { importES256Key, exchangeToken, TokenExchangeError } from "./jwt-utils.js";

// Vault auth & runtime (M2 extractions)
export { VaultTokenManager } from "./vault-token-manager.js";
export { VaultActionProxy } from "./vault-action-proxy.js";
export { VaultCredentialProvider } from "./vault-provider.js";

// Patch runtime (separate entry point at @agenthifive/agenthifive/runtime)
export { verifyPatches } from "./patch-verify.js";
export type { PatchStatus } from "./patch-verify.js";

// Session context
export {
  setCurrentSessionContext,
  getCurrentSessionContext,
  parseSessionKey,
} from "./session-context.js";

// Pending approvals
export {
  initPendingApprovals,
  addPendingApproval,
  loadPendingApprovals,
  savePendingApprovals,
} from "./pending-approvals.js";

// Types
export type {
  OpenClawPluginConfig,
  OpenClawAuthConfig,
  ExecuteInput,
  ExecuteOutput,
  ExecuteApprovalOutput,
  ApprovalRequestInput,
  ApprovalRequestOutput,
  ApprovalCommitInput,
  ApprovalCommitOutput,
  ConnectionListItem,
  ConnectionsListOutput,
  ConnectionRevokeInput,
  ConnectionRevokeOutput,
  // M2 types
  ActionProxy,
  ProxyRequest,
  ProxyResponse,
  CredentialProvider,
  CredentialQuery,
  CredentialResult,
  VaultProviderConfig,
  VaultTokenManagerConfig,
  SessionContext,
  PendingApproval,
  PluginLogger,
} from "./types.js";

export type {
  Ah5Attachment,
  Ah5ChannelAction,
  Ah5ChannelProvider,
  Ah5InboundEvent,
  ChannelActionApprovalRequired,
  ChannelActionBlocked,
  ChannelActionCompletedEvent,
  ChannelActionFailed,
  ChannelActionLifecycleEvent,
  ChannelActionPendingApprovalEvent,
  ChannelActionResult,
  ChannelActionSent,
  PendingChannelAction,
  PendingChannelActionStatus,
} from "./channels/types.js";

// Individual tool functions (for advanced usage)
export {
  execute,
  approvalRequest,
  approvalCommit,
  connectionsList,
  connectionRevoke,
} from "./tools.js";
