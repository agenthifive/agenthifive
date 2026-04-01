/**
 * Proxied Slack WebClient factory.
 *
 * Wraps a WebClient to route all API calls through the AgentHiFive vault proxy.
 * All SDK methods (chat.postMessage, reactions.add, etc.) route through the
 * WebClient.apiCall() method — overriding that single method intercepts everything.
 *
 * Requires `@slack/web-api` as an optional peer dependency.
 */

import type { WebAPICallResult, WebClient } from "@slack/web-api";
import type { ActionProxy } from "../action-proxy.js";

/**
 * Create a proxied Slack WebClient that routes all API calls through the vault.
 *
 * @param proxy - The action proxy to route requests through
 * @param client - A WebClient instance to override. If not provided, the caller
 *   must supply one — the SDK does not create WebClient instances internally.
 */
export function createProxiedSlackWebClient(proxy: ActionProxy, client: WebClient): WebClient {
  // Override apiCall — the single method all SDK methods route through
  client.apiCall = async (
    method: string,
    options?: Record<string, unknown>,
  ): Promise<WebAPICallResult> => {
    const action = classifySlackAction(method);

    const result = await proxy.execute({
      service: "slack",
      method: "POST",
      url: `https://slack.com/api/${method}`,
      body: options,
      context: {
        tool: "slack_actions",
        action,
        channel: "slack",
      },
    });

    if (result.blocked) {
      throw new Error(
        `Policy blocked: ${result.blocked.reason} (policy: ${result.blocked.policy})`,
      );
    }

    return result.body as WebAPICallResult;
  };

  return client;
}

/**
 * Map Slack API method names to human-readable action names for policy evaluation.
 */
function classifySlackAction(method: string): string {
  const map: Record<string, string> = {
    "chat.postMessage": "send_message",
    "chat.update": "edit_message",
    "chat.delete": "delete_message",
    "reactions.add": "add_reaction",
    "reactions.remove": "remove_reaction",
    "reactions.get": "list_reactions",
    "files.uploadV2": "upload_file",
    "conversations.history": "read_messages",
    "conversations.replies": "read_thread",
    "conversations.list": "list_channels",
    "conversations.open": "open_dm",
    "users.info": "get_member_info",
    "users.list": "list_members",
    "emoji.list": "list_emoji",
    "pins.add": "pin_message",
    "pins.remove": "unpin_message",
    "pins.list": "list_pins",
  };
  return map[method] ?? method.replace(".", "_");
}
