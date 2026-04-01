"use client";

import { useSearchParams } from "next/navigation";

const STATUS_CONFIG: Record<string, { icon: string; title: string; message: string }> = {
  approved: {
    icon: "\u2705",
    title: "Request Approved",
    message: "The agent\u2019s request has been approved. The agent can now proceed with the action.",
  },
  denied: {
    icon: "\u274C",
    title: "Request Denied",
    message: "The agent\u2019s request has been denied.",
  },
  expired: {
    icon: "\u23F1\uFE0F",
    title: "Request Expired",
    message: "This approval request has expired. The agent will need to submit a new request.",
  },
  not_found: {
    icon: "\u2753",
    title: "Request Not Found",
    message: "This approval link is no longer valid. It may have already been used.",
  },
  already_approved: {
    icon: "\u2139\uFE0F",
    title: "Already Approved",
    message: "This request was already approved.",
  },
  already_denied: {
    icon: "\u2139\uFE0F",
    title: "Already Denied",
    message: "This request was already denied.",
  },
  already_consumed: {
    icon: "\u2139\uFE0F",
    title: "Already Processed",
    message: "This request has already been processed by the agent.",
  },
  already_expired: {
    icon: "\u23F1\uFE0F",
    title: "Request Expired",
    message: "This approval request expired before it could be acted on.",
  },
  already_resolved: {
    icon: "\u2139\uFE0F",
    title: "Already Resolved",
    message: "This request was resolved by someone else just now.",
  },
};

export default function ResultContent() {
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "not_found";

  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG["not_found"]!;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full text-center">
        <div className="text-5xl mb-4">{config.icon}</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">{config.title}</h1>
        <p className="text-sm text-gray-600 mb-6">{config.message}</p>
        <a
          href="/dashboard/approvals"
          className="inline-block rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Open Dashboard
        </a>
        <p className="mt-4 text-xs text-gray-400">
          You can close this tab.
        </p>
      </div>
    </div>
  );
}
