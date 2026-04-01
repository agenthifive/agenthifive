import { join } from "node:path";
import { pathExists, readText, writeText } from "../env-paths.js";
import type { PluginLogger } from "../pending-approvals.js";
import type { ChannelActionLifecycleEvent } from "./types.js";

const CHANNEL_LIFECYCLE_EVENTS_FILE = "vault-channel-lifecycle-events.json";

let _stateDir = "";
let _log: PluginLogger = console;

function ensureInitialized(): void {
  if (!_stateDir) {
    throw new Error("channel lifecycle events not initialized");
  }
}

function eventsPath(): string {
  ensureInitialized();
  return join(_stateDir, CHANNEL_LIFECYCLE_EVENTS_FILE);
}

function sortEvents(events: ChannelActionLifecycleEvent[]): ChannelActionLifecycleEvent[] {
  return [...events];
}

export function initChannelLifecycleEvents(stateDir: string, logger?: PluginLogger): void {
  _stateDir = stateDir;
  if (logger) _log = logger;
}

export function loadChannelLifecycleEvents(): ChannelActionLifecycleEvent[] {
  const filePath = eventsPath();
  if (!pathExists(filePath)) return [];

  try {
    const parsed = JSON.parse(readText(filePath)) as ChannelActionLifecycleEvent[];
    return Array.isArray(parsed) ? sortEvents(parsed) : [];
  } catch (err) {
    _log.warn?.(`[channel-lifecycle-events] failed to parse store, returning empty: ${String(err)}`);
    return [];
  }
}

export function saveChannelLifecycleEvents(events: ChannelActionLifecycleEvent[]): void {
  writeText(eventsPath(), JSON.stringify(sortEvents(events), null, 2));
}

export function addChannelLifecycleEvent(event: ChannelActionLifecycleEvent): void {
  const events = loadChannelLifecycleEvents();
  events.push(event);
  saveChannelLifecycleEvents(events);
}

export function consumeChannelLifecycleEvents(): ChannelActionLifecycleEvent[] {
  const events = loadChannelLifecycleEvents();
  saveChannelLifecycleEvents([]);
  return events;
}
