"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";

interface NotificationChannel {
  id: string;
  channelType: string;
  enabled: boolean;
  connectionId: string | null;
  config: { chatId?: string; channelId?: string };
  verificationStatus: string;
  createdAt: string;
}

interface BotConnection {
  id: string;
  provider: string;
  label: string;
  metadata: { username?: string; teamName?: string } | null;
}

interface DetectedChat {
  chatId: string;
  name: string;
  type: string;
  username: string | null;
}

export default function NotificationsPage() {
  const { data: session } = useSession();

  const [notifChannels, setNotifChannels] = useState<NotificationChannel[]>([]);
  const [botConnections, setBotConnections] = useState<BotConnection[]>([]);

  // Telegram form
  const [tgConnectionId, setTgConnectionId] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [savingTg, setSavingTg] = useState(false);
  const [tgMessage, setTgMessage] = useState<string | null>(null);

  // Telegram chat detection
  const [detectingChats, setDetectingChats] = useState(false);
  const [detectedChats, setDetectedChats] = useState<DetectedChat[]>([]);

  // Slack form
  const [slackConnectionId, setSlackConnectionId] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [savingSlack, setSavingSlack] = useState(false);
  const [slackMessage, setSlackMessage] = useState<string | null>(null);

  const fetchNotificationChannels = useCallback(async () => {
    try {
      const [channelRes, connRes] = await Promise.all([
        apiFetch("/notification-channels"),
        apiFetch("/connections"),
      ]);
      if (channelRes.ok) {
        const data = (await channelRes.json()) as { channels: NotificationChannel[] };
        setNotifChannels(data.channels);
        // Pre-fill forms if channels exist
        const tg = data.channels.find((c) => c.channelType === "telegram");
        if (tg) {
          setTgConnectionId(tg.connectionId ?? "");
          setTgChatId(tg.config.chatId ?? "");
        }
        const slack = data.channels.find((c) => c.channelType === "slack");
        if (slack) {
          setSlackConnectionId(slack.connectionId ?? "");
          setSlackChannelId(slack.config.channelId ?? "");
        }
      }
      if (connRes.ok) {
        const data = (await connRes.json()) as {
          connections: Array<{
            id: string;
            provider: string;
            label: string;
            status: string;
            metadata: { username?: string; teamName?: string } | null;
          }>;
        };
        const bots = data.connections
          .filter((c) => (c.provider === "telegram" || c.provider === "slack") && c.status === "healthy")
          .map((c) => ({ id: c.id, provider: c.provider, label: c.label, metadata: c.metadata }));
        setBotConnections(bots);
        // Auto-select if only one Telegram bot and no selection yet
        const tgBots = bots.filter((b) => b.provider === "telegram");
        if (tgBots.length === 1 && !tgConnectionId) {
          setTgConnectionId(tgBots[0]!.id);
        }
        // Auto-select if only one Slack bot and no selection yet
        const slackBots = bots.filter((b) => b.provider === "slack");
        if (slackBots.length === 1 && !slackConnectionId) {
          setSlackConnectionId(slackBots[0]!.id);
        }
      }
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    if (session) {
      fetchNotificationChannels();
    }
  }, [session, fetchNotificationChannels]);

  return (
    <div className="max-w-xl">
      <div className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">Approval Notifications</h2>
        <p className="mt-1 text-sm text-muted">
          Get notified on Telegram or Slack when agents need approval. Approve or deny directly from the message.
        </p>

        <div className="mt-4 space-y-4">
          {/* In-app — always on */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">In-app notifications</p>
              <p className="text-xs text-muted">Receive notifications in the dashboard</p>
            </div>
            <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
              Always on
            </span>
          </div>

          {/* Telegram */}
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">Telegram</p>
            <p className="mt-1 text-xs text-muted">
              Receive approval requests on Telegram with Approve / Deny buttons.
            </p>

            {botConnections.filter((c) => c.provider === "telegram").length === 0 ? (
              <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-200 p-3">
                <p className="text-sm text-yellow-800">
                  No Telegram bots connected.{" "}
                  <a href="/dashboard/connections" className="font-medium underline hover:text-yellow-900">
                    Connect a Telegram bot
                  </a>{" "}
                  first.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {/* Existing channel status */}
                {(() => {
                  const existing = notifChannels.find((c) => c.channelType === "telegram");
                  if (existing) {
                    return (
                      <div className="flex items-center justify-between rounded-md border border-border p-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              Chat ID: {existing.config.chatId}
                            </span>
                            {existing.verificationStatus === "verified" ? (
                              <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                                Verified
                              </span>
                            ) : (
                              <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs font-medium text-yellow-700">
                                Pending
                              </span>
                            )}
                            {!existing.enabled && (
                              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">
                                Disabled
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              try {
                                const res = await apiFetch(`/notification-channels/${existing.id}/enabled`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ enabled: !existing.enabled }),
                                });
                                if (res.ok) {
                                  fetchNotificationChannels();
                                  setTgMessage(existing.enabled ? "Telegram disabled." : "Telegram enabled.");
                                }
                              } catch {
                                setTgMessage("Failed to toggle channel.");
                              }
                            }}
                            className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-gray-50"
                          >
                            {existing.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await apiFetch(`/notification-channels/${existing.id}`, { method: "DELETE" });
                                setNotifChannels((prev) => prev.filter((c) => c.id !== existing.id));
                                setTgConnectionId("");
                                setTgChatId("");
                                setTgMessage("Channel removed.");
                              } catch {
                                setTgMessage("Failed to remove channel.");
                              }
                            }}
                            className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Form */}
                <div className="space-y-3">
                  {/* Bot selector — hidden if only one */}
                  {botConnections.filter((c) => c.provider === "telegram").length > 1 && (
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">Telegram bot</label>
                      <select
                        value={tgConnectionId}
                        onChange={(e) => { setTgConnectionId(e.target.value); setDetectedChats([]); setTgChatId(""); }}
                        className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground"
                      >
                        <option value="">Select a bot...</option>
                        {botConnections.filter((c) => c.provider === "telegram").map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}{c.metadata?.username ? ` (@${c.metadata.username})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Chat detection */}
                  {tgConnectionId && (
                    <div className="space-y-3">
                      {/* Step 1: Instruct user to message the bot, then detect */}
                      {!tgChatId && detectedChats.length === 0 && (
                        <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                          <p className="text-sm text-blue-800">
                            Send any message to your bot{" "}
                            {(() => {
                              const bot = botConnections.find((c) => c.id === tgConnectionId);
                              return bot?.metadata?.username
                                ? <a href={`https://t.me/${bot.metadata.username}`} target="_blank" rel="noopener noreferrer" className="font-medium underline">@{bot.metadata.username}</a>
                                : <span className="font-medium">on Telegram</span>;
                            })()}{" "}
                            so we can detect your chat.
                          </p>
                          <button
                            disabled={detectingChats}
                            onClick={async () => {
                              setDetectingChats(true);
                              setTgMessage(null);
                              try {
                                const res = await apiFetch("/notification-channels/telegram/detect-chats", {
                                  method: "POST",
                                  body: JSON.stringify({ connectionId: tgConnectionId }),
                                });
                                if (!res.ok) {
                                  const data = (await res.json()) as { error: string };
                                  setTgMessage(data.error);
                                  return;
                                }
                                const data = (await res.json()) as { chats: DetectedChat[] };
                                if (data.chats.length === 0) {
                                  setTgMessage("No messages found. Send a message to the bot first, then try again.");
                                } else if (data.chats.length === 1) {
                                  setTgChatId(data.chats[0]!.chatId);
                                  setDetectedChats(data.chats);
                                } else {
                                  setDetectedChats(data.chats);
                                }
                              } catch {
                                setTgMessage("Failed to detect chats.");
                              } finally {
                                setDetectingChats(false);
                              }
                            }}
                            className="mt-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                          >
                            {detectingChats ? "Detecting..." : "Detect my chat"}
                          </button>
                        </div>
                      )}

                      {/* Step 2: Multiple chats found — let user pick */}
                      {detectedChats.length > 1 && !tgChatId && (
                        <div>
                          <label className="block text-xs font-medium text-muted mb-1">Select your chat</label>
                          <select
                            value={tgChatId}
                            onChange={(e) => setTgChatId(e.target.value)}
                            className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground"
                          >
                            <option value="">Choose...</option>
                            {detectedChats.map((chat) => (
                              <option key={chat.chatId} value={chat.chatId}>
                                {chat.name}{chat.username ? ` (@${chat.username})` : ""} — {chat.type}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Selected chat display */}
                      {tgChatId && (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-foreground">
                            {(() => {
                              const found = detectedChats.find((c) => c.chatId === tgChatId);
                              return found ? `${found.name}${found.username ? ` (@${found.username})` : ""}` : `Chat ID: ${tgChatId}`;
                            })()}
                          </span>
                          <button
                            type="button"
                            onClick={() => { setTgChatId(""); setDetectedChats([]); }}
                            className="text-xs text-blue-600 underline hover:text-blue-800"
                          >
                            Change
                          </button>
                        </div>
                      )}

                      {/* Manual fallback */}
                      {!tgChatId && detectedChats.length === 0 && !detectingChats && (
                        <p className="text-xs text-muted">
                          Or enter a Chat ID manually:{" "}
                          <button
                            type="button"
                            onClick={() => {
                              const id = prompt("Enter your Telegram Chat ID:");
                              if (id?.trim()) setTgChatId(id.trim());
                            }}
                            className="text-blue-600 underline hover:text-blue-800"
                          >
                            enter manually
                          </button>
                        </p>
                      )}
                    </div>
                  )}

                  {/* Save & Test */}
                  <div className="flex gap-2">
                    <button
                      disabled={!tgConnectionId || !tgChatId || savingTg}
                      onClick={async () => {
                        setSavingTg(true);
                        setTgMessage(null);
                        try {
                          const saveRes = await apiFetch("/notification-channels", {
                            method: "POST",
                            body: JSON.stringify({
                              channelType: "telegram",
                              connectionId: tgConnectionId,
                              config: { chatId: tgChatId },
                            }),
                          });
                          if (!saveRes.ok) {
                            const data = (await saveRes.json()) as { error: string };
                            setTgMessage(data.error);
                            return;
                          }
                          const { channel } = (await saveRes.json()) as { channel: NotificationChannel };
                          const testRes = await apiFetch(`/notification-channels/${channel.id}/test`, {
                            method: "POST",
                          });
                          const testData = (await testRes.json()) as { ok: boolean; error?: string };
                          if (testData.ok) {
                            setTgMessage("Saved and verified! Check your Telegram.");
                          } else {
                            setTgMessage(`Saved but test failed: ${testData.error ?? "Unknown error"}. Make sure you've messaged the bot first.`);
                          }
                          fetchNotificationChannels();
                        } catch {
                          setTgMessage("Failed to save channel.");
                        } finally {
                          setSavingTg(false);
                        }
                      }}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    >
                      {savingTg ? "Saving..." : "Save & Test"}
                    </button>
                  </div>
                  {tgMessage && (
                    <p className={`text-sm ${tgMessage.includes("verified") || tgMessage.includes("Saved and") || tgMessage.includes("enabled") || tgMessage.includes("removed") ? "text-green-600" : "text-red-600"}`}>
                      {tgMessage}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Slack */}
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">Slack</p>
            <p className="mt-1 text-xs text-muted">
              Receive approval requests in a Slack channel with Approve / Deny buttons.
            </p>

            {botConnections.filter((c) => c.provider === "slack").length === 0 ? (
              <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-200 p-3">
                <p className="text-sm text-yellow-800">
                  No Slack bots connected.{" "}
                  <a href="/dashboard/connections" className="font-medium underline hover:text-yellow-900">
                    Connect a Slack bot
                  </a>{" "}
                  first.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {/* Existing channel status */}
                {(() => {
                  const existing = notifChannels.find((c) => c.channelType === "slack");
                  if (existing) {
                    return (
                      <div className="flex items-center justify-between rounded-md border border-border p-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              Channel: {existing.config.channelId}
                            </span>
                            {existing.verificationStatus === "verified" ? (
                              <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                                Verified
                              </span>
                            ) : (
                              <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs font-medium text-yellow-700">
                                Pending
                              </span>
                            )}
                            {!existing.enabled && (
                              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">
                                Disabled
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              try {
                                const res = await apiFetch(`/notification-channels/${existing.id}/enabled`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ enabled: !existing.enabled }),
                                });
                                if (res.ok) {
                                  fetchNotificationChannels();
                                  setSlackMessage(existing.enabled ? "Slack disabled." : "Slack enabled.");
                                }
                              } catch {
                                setSlackMessage("Failed to toggle channel.");
                              }
                            }}
                            className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-gray-50"
                          >
                            {existing.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await apiFetch(`/notification-channels/${existing.id}`, { method: "DELETE" });
                                setNotifChannels((prev) => prev.filter((c) => c.id !== existing.id));
                                setSlackConnectionId("");
                                setSlackChannelId("");
                                setSlackMessage("Channel removed.");
                              } catch {
                                setSlackMessage("Failed to remove channel.");
                              }
                            }}
                            className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Form */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Slack bot</label>
                    <select
                      value={slackConnectionId}
                      onChange={(e) => setSlackConnectionId(e.target.value)}
                      className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground"
                    >
                      <option value="">Select a bot...</option>
                      {botConnections.filter((c) => c.provider === "slack").map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}{c.metadata?.teamName ? ` (${c.metadata.teamName})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Channel ID</label>
                    <input
                      type="text"
                      value={slackChannelId}
                      onChange={(e) => setSlackChannelId(e.target.value)}
                      placeholder="e.g. C0123456789"
                      className="w-full rounded-md border border-border px-3 py-2 text-sm text-foreground"
                    />
                    <p className="mt-1 text-xs text-muted">
                      Right-click a channel in Slack, select &ldquo;View channel details&rdquo;,
                      then copy the Channel ID from the bottom of the panel.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      disabled={!slackConnectionId || !slackChannelId || savingSlack}
                      onClick={async () => {
                        setSavingSlack(true);
                        setSlackMessage(null);
                        try {
                          const saveRes = await apiFetch("/notification-channels", {
                            method: "POST",
                            body: JSON.stringify({
                              channelType: "slack",
                              connectionId: slackConnectionId,
                              config: { channelId: slackChannelId },
                            }),
                          });
                          if (!saveRes.ok) {
                            const data = (await saveRes.json()) as { error: string };
                            setSlackMessage(data.error);
                            return;
                          }
                          const { channel } = (await saveRes.json()) as { channel: NotificationChannel };
                          const testRes = await apiFetch(`/notification-channels/${channel.id}/test`, {
                            method: "POST",
                          });
                          const testData = (await testRes.json()) as { ok: boolean; error?: string };
                          if (testData.ok) {
                            setSlackMessage("Saved and verified! Check your Slack channel.");
                          } else {
                            setSlackMessage(`Saved but test failed: ${testData.error ?? "Unknown error"}. Make sure the bot is invited to the channel.`);
                          }
                          fetchNotificationChannels();
                        } catch {
                          setSlackMessage("Failed to save channel.");
                        } finally {
                          setSavingSlack(false);
                        }
                      }}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    >
                      {savingSlack ? "Saving..." : "Save & Test"}
                    </button>
                  </div>
                  {slackMessage && (
                    <p className={`text-sm ${slackMessage.includes("verified") || slackMessage.includes("Saved and") || slackMessage.includes("enabled") || slackMessage.includes("removed") ? "text-green-600" : "text-red-600"}`}>
                      {slackMessage}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Email — coming soon */}
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Email notifications</p>
                <p className="text-xs text-muted">Get email alerts for approval requests</p>
              </div>
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Coming soon
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
