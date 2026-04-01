// Core types
export type { CredentialProvider, CredentialQuery, CredentialResult } from "./types.js";
export type { ActionProxy, ProxyRequest, ProxyResponse } from "./action-proxy.js";
export type { CapabilityCache, CapabilityCacheEntry } from "./vault-capabilities.js";
export type { VaultAuth, VaultConfig, VaultLogger } from "./config.js";

// Implementations
export { VaultActionProxy } from "./vault-action-proxy.js";
export { VaultCredentialProvider } from "./vault-provider.js";
export { VaultCapabilityCache } from "./vault-capabilities.js";
export { LocalCredentialProvider } from "./local-provider.js";
export { ChainedCredentialProvider } from "./chained-provider.js";

// Config helpers
export { noopLogger, consoleLogger } from "./config.js";

// Utilities
export { TOOL_TO_ACTION_TEMPLATE, getActionTemplateId, requiresCapabilityCheck } from "./action-templates.js";
export { registerCallbackHandler, getCallbackHandler } from "./callbacks.js";
export { sleepWithAbort, computeBackoff } from "./backoff.js";
export type { BackoffPolicy } from "./backoff.js";

// Channel proxy factories
export { createProxiedTelegramFetch } from "./channels/telegram-proxy.js";
export { createProxiedSlackWebClient } from "./channels/slack-proxy.js";
export { createProxiedGraphFetch } from "./channels/graph-proxy.js";

// Channel pollers
export { startVaultTelegramPoller } from "./channels/telegram-poller.js";
export type { VaultTelegramPollerOpts, TelegramUpdate, TelegramMessage, TelegramUser, TelegramChat } from "./channels/telegram-poller.js";
export { startVaultSlackPoller } from "./channels/slack-poller.js";
export type { VaultSlackPollerOpts, SlackMessage, SlackChannelInfo } from "./channels/slack-poller.js";

// Channel watcher
export { startVaultChannelWatcher, stopVaultChannelWatcher } from "./channels/channel-watcher.js";
export type { PollerFactory, VaultChannelWatcherOpts } from "./channels/channel-watcher.js";
