/**
 * Callback handler registry for permission request button clicks.
 *
 * Maps callback_data strings (from inline buttons) to one-shot handler
 * functions. Used to process "perm_req:*" callbacks.
 */

// Global callback handler registry
const callbackHandlers = new Map<string, () => Promise<void>>();

/**
 * Register a callback handler for a button click.
 */
export function registerCallbackHandler(callbackId: string, handler: () => Promise<void>): void {
  callbackHandlers.set(callbackId, handler);
}

/**
 * Get and remove a callback handler (one-shot execution).
 */
export function getCallbackHandler(callbackData: string): (() => Promise<void>) | undefined {
  const handler = callbackHandlers.get(callbackData);
  if (handler) {
    callbackHandlers.delete(callbackData);
  }
  return handler;
}
