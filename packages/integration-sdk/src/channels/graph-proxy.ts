/**
 * Graph API proxy wrapper for Microsoft services (Teams, Outlook, etc.).
 *
 * Provides a fetch-compatible function routing through the AgentHiFive vault
 * proxy. Since most Graph API wrappers accept `fetchFn?: typeof fetch`,
 * callers just pass this as their fetch implementation.
 *
 * When no proxy is provided, returns undefined — callers default to native fetch.
 */

import type { ActionProxy, ProxyRequest } from "../action-proxy.js";

/**
 * Classify a Graph API URL into a human-readable action for policy evaluation.
 */
function classifyGraphAction(url: string, method: string): string {
  if (url.includes("/drive/root:") && method === "PUT") return "upload_file";
  if (url.includes("/createLink")) return "create_sharing_link";
  if (url.includes("/drive/items/")) return "get_drive_item";
  if (url.includes("/members")) return "get_chat_members";
  if (url.includes("/messages/")) return "get_message";
  if (url.includes("/hostedContents")) return "get_hosted_content";
  if (url.includes("/shares/")) return "download_shared_file";
  if (url.includes("/groups")) return "list_teams";
  if (url.includes("/channels")) return "list_channels";
  if (url.includes("/users")) return "search_users";
  return "graph_api";
}

/**
 * Create a fetch-compatible function that routes Graph API calls through the vault proxy.
 *
 * @param proxy - The action proxy to route requests through
 * @param connectionId - AgentHiFive connection ID for this Microsoft credential
 */
export function createProxiedGraphFetch(
  proxy: ActionProxy,
  connectionId: string,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const action = classifyGraphAction(url, method);

    // Extract headers as plain object
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const entry of init.headers) {
          const [k, v] = entry as [string, string];
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Parse body — could be string, Buffer, or Uint8Array
    let body: unknown = undefined;
    if (init?.body !== null && init?.body !== undefined) {
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        body = {
          _binary: true,
          data: Buffer.from(init.body).toString("base64"),
          contentType: headers["content-type"] ?? headers["Content-Type"],
        };
      } else {
        body = init.body;
      }
    }

    const result = await proxy.execute({
      connectionId,
      method: method as ProxyRequest["method"],
      url,
      headers,
      body,
      context: {
        tool: "msteams",
        action,
        channel: "msteams",
      },
    });

    if (result.blocked) {
      throw new Error(
        `Policy blocked: ${result.blocked.reason} (policy: ${result.blocked.policy})`,
      );
    }

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: result.headers,
    });
  };
}
