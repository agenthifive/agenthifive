/**
 * Generic vault channel watcher.
 *
 * Background task that monitors the AgentHiFive vault capability cache
 * for active service connections. When a new connection appears for a
 * registered service (e.g. Telegram, Slack), the watcher auto-starts
 * the corresponding poller. When the connection is removed, the poller
 * is stopped.
 *
 * This eliminates the need for static channel config when the vault
 * manages the service.
 */

import type { ActionProxy } from "../action-proxy.js";
import type { VaultLogger } from "../config.js";
import { noopLogger } from "../config.js";
import type { CapabilityCache } from "../vault-capabilities.js";
import { sleepWithAbort } from "../backoff.js";

/**
 * A poller factory for a specific service. The watcher calls `start()`
 * when a connection appears and aborts the signal when it disappears.
 */
export type PollerFactory = {
  /** Start the poller. Returns when aborted or crashed. */
  start(opts: { proxy: ActionProxy; signal: AbortSignal }): Promise<void>;
};

export type VaultChannelWatcherOpts = {
  capabilityCache: CapabilityCache;
  proxy: ActionProxy;
  /** Map of service name → poller factory. E.g., { telegram: ..., slack: ... } */
  pollers: Record<string, PollerFactory>;
  signal: AbortSignal;
  /** How often to check for capability changes (ms). Default: 60_000 */
  checkIntervalMs?: number;
  /** Logger (defaults to no-op) */
  logger?: VaultLogger;
};

// Module-scoped state
let watcherAbort: AbortController | null = null;
const activePollers = new Map<string, AbortController>();

/**
 * Start the vault channel watcher.
 *
 * Periodically checks the vault capability cache for active connections
 * and auto-starts/stops channel pollers accordingly.
 */
export async function startVaultChannelWatcher(opts: VaultChannelWatcherOpts): Promise<void> {
  const {
    capabilityCache,
    proxy,
    pollers,
    signal: externalSignal,
    checkIntervalMs = 60_000,
  } = opts;
  const log = opts.logger ?? noopLogger;

  // Stop any previous watcher
  stopVaultChannelWatcher();
  watcherAbort = new AbortController();

  // Combine external signal with our internal abort
  const signal = AbortSignal.any([externalSignal, watcherAbort.signal]);

  const serviceNames = Object.keys(pollers);
  log.info(`started — watching services: ${serviceNames.join(", ")}`);

  while (!signal.aborted) {
    try {
      const caps = await capabilityCache.fetch();

      for (const [service, factory] of Object.entries(pollers)) {
        const hasConnection = caps.activeConnections.some((c) => c.service === service);

        if (hasConnection && !activePollers.has(service)) {
          log.info(`detected active ${service} connection — starting poller`);
          const pollerAbort = new AbortController();
          activePollers.set(service, pollerAbort);

          // Fire-and-forget — the poller runs until aborted
          factory
            .start({ proxy, signal: pollerAbort.signal })
            .catch((err) => {
              log.error(`${service} poller exited with error: ${String(err)}`);
              activePollers.delete(service);
            });
        } else if (!hasConnection && activePollers.has(service)) {
          log.info(`${service} connection removed — stopping poller`);
          activePollers.get(service)!.abort();
          activePollers.delete(service);
        }
      }
    } catch (err) {
      log.error(`capability check failed: ${String(err)}`);
    }

    try {
      await sleepWithAbort(checkIntervalMs, signal);
    } catch {
      break; // AbortError from signal
    }
  }

  // Clean up all pollers on shutdown
  for (const [service, abort] of activePollers) {
    log.info(`stopping ${service} poller`);
    abort.abort();
  }
  activePollers.clear();
  log.info("stopped");
}

/**
 * Stop the vault channel watcher and all active pollers.
 */
export function stopVaultChannelWatcher(): void {
  if (watcherAbort) {
    watcherAbort.abort();
    watcherAbort = null;
  }
}
