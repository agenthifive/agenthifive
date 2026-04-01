"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";

export default function DashboardPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!session) return;

    async function checkAgents() {
      try {
        const res = await apiFetch("/agents");
        if (!res.ok) {
          // If we can't check agents, go to my-agents (default view)
          router.push("/dashboard/my-agents");
          return;
        }

        const data = (await res.json()) as { agents: Array<{ id: string }> };

        if (data.agents.length === 0) {
          // No agents — first-time user
          router.push("/dashboard/setup");
          return;
        }

        // Agent exists — check if it has connections (completed setup)
        const connRes = await apiFetch("/connections");
        if (connRes.ok) {
          const connData = (await connRes.json()) as { connections: unknown[] };
          if (connData.connections.length === 0) {
            // Agent but no connections — resume setup wizard
            router.push("/dashboard/setup");
            return;
          }
        }

        // Has agents with connections — go to dashboard
        router.push("/dashboard/my-agents");
      } catch {
        // On error, default to my-agents
        router.push("/dashboard/my-agents");
      } finally {
        setChecking(false);
      }
    }

    checkAgents();
  }, [session, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-muted">Loading...</div>
    </div>
  );
}
