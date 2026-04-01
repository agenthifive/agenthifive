"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-client";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  linkUrl: string | null;
  read: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const TYPE_ICONS: Record<string, string> = {
  permission_request: "🔑",
  connection_issue: "⚠️",
  approval_request: "📋",
  security_alert: "🛡️",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fetch unread count on mount and every 30s
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await apiFetch("/notifications/unread-count");
      if (res.ok) {
        const data = (await res.json()) as { count: number };
        setUnreadCount(data.count);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30_000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Fetch full notification list when panel opens
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/notifications?limit=20");
      if (res.ok) {
        const data = (await res.json()) as { notifications: Notification[] };
        setNotifications(data.notifications);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      fetchNotifications();
    }
  }, [open, fetchNotifications]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleMarkAsRead(id: string) {
    try {
      const res = await apiFetch(`/notifications/${id}/read`, { method: "POST" });
      if (res.ok) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      }
    } catch { /* ignore */ }
  }

  async function handleMarkAllAsRead() {
    try {
      const res = await apiFetch("/notifications/read-all", { method: "POST" });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
        setUnreadCount(0);
      }
    } catch { /* ignore */ }
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="relative rounded-md p-1.5 text-muted hover:text-foreground hover:bg-gray-100 transition-colors"
        aria-label="Notifications"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 rounded-lg border border-border bg-white shadow-lg z-50">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-96 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted">
                Loading...
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted">
                No notifications yet
              </div>
            ) : (
              <div>
                {notifications.map((notif) => {
                  const icon = TYPE_ICONS[notif.type] ?? "📌";
                  const content = (
                    <div
                      className={`flex gap-3 px-4 py-3 border-b border-border last:border-0 transition-colors ${
                        notif.read
                          ? "bg-white hover:bg-gray-50"
                          : "bg-blue-50 hover:bg-blue-100"
                      }`}
                    >
                      <span className="text-lg shrink-0 mt-0.5">{icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-sm leading-tight ${notif.read ? "text-foreground" : "font-medium text-foreground"}`}>
                            {notif.title}
                          </p>
                          {!notif.read && (
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                              }}
                              className="shrink-0 rounded-full p-0.5 text-muted hover:text-foreground hover:bg-gray-200"
                              title="Mark as read"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-muted mt-0.5 line-clamp-2">{notif.body}</p>
                        <p className="text-[10px] text-muted mt-1">{timeAgo(notif.createdAt)}</p>
                      </div>
                    </div>
                  );

                  if (notif.linkUrl) {
                    return (
                      <Link
                        key={notif.id}
                        href={notif.linkUrl}
                        onClick={() => {
                          if (!notif.read) handleMarkAsRead(notif.id);
                          setOpen(false);
                        }}
                        className="block"
                      >
                        {content}
                      </Link>
                    );
                  }

                  return <div key={notif.id}>{content}</div>;
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
