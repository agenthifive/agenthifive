"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import Step1LlmProvider from "@/components/features/onboarding/step1-llm-provider";
import Step2ConnectAccounts from "@/components/features/onboarding/step2-connect-accounts";

type SetupStep = "llm" | "accounts" | "complete";

export default function SetupPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [bootstrapSecret, setBootstrapSecret] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<SetupStep>("llm");
  const [copied, setCopied] = useState(false);
  const hasChecked = useRef(false);

  // Check if user already has agents - if so, redirect to dashboard
  useEffect(() => {
    if (!session || hasChecked.current) return;
    hasChecked.current = true;

    async function checkAndCreateAgent() {
      try {
        const res = await apiFetch("/agents");
        if (!res.ok) {
          setError("Failed to check existing agents");
          setLoading(false);
          return;
        }

        const data = (await res.json()) as { agents: Array<{ id: string }> };

        if (data.agents.length > 0) {
          // Agent exists — check if it has connections (completed setup)
          const existingAgent = data.agents[0]!;
          const connRes = await apiFetch("/connections");
          if (connRes.ok) {
            const connData = (await connRes.json()) as { connections: unknown[] };
            if (connData.connections.length > 0) {
              // Has connections — setup is done, go to dashboard
              router.push("/dashboard/my-agents");
              return;
            }
          }
          // Agent exists but no connections — resume setup wizard
          setAgentId(existingAgent.id);
          setLoading(false);
          return;
        }

        // No agents exist — create OpenClaw agent
        const createRes = await apiFetch("/agents", {
          method: "POST",
          body: JSON.stringify({
            name: "OpenClaw",
            description: "AI assistant that helps you manage your emails, calendar, and tasks",
          }),
        });

        if (!createRes.ok) {
          const errorData = (await createRes.json()) as { error: string };
          throw new Error(errorData.error || "Failed to create agent");
        }

        const createData = (await createRes.json()) as {
          agent: { id: string };
          bootstrapSecret: string;
        };

        setAgentId(createData.agent.id);
        setBootstrapSecret(createData.bootstrapSecret);
        setLoading(false);
      } catch (err) {
        console.error("Error setting up agent:", err);
        setError(err instanceof Error ? err.message : "Failed to setup");
        setLoading(false);
      }
    }

    checkAndCreateAgent();
  }, [session, router]);

  const handleLlmComplete = (provider: string, credential: string, connectionId: string) => {
    console.log("LLM connection created:", { provider, connectionId });
    setCurrentStep("accounts");
  };

  const handleAccountsContinue = async () => {
    setCurrentStep("complete");
  };

  const handleFinish = () => {
    router.push("/dashboard/my-agents");
  };

  const handleCopySecret = async () => {
    if (!bootstrapSecret) return;
    try {
      await navigator.clipboard.writeText(bootstrapSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  if (isPending || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted">Setting up your workspace...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm text-red-700">{error}</p>
          <div className="mt-4 flex gap-3 justify-center">
            <button
              onClick={() => {
                setError(null);
                setLoading(true);
                window.location.reload();
              }}
              className="rounded-md border border-red-600 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              Retry
            </button>
            <button
              onClick={() => router.push("/dashboard/my-agents")}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!agentId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted">Preparing your agent...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        {/* Header with skip button */}
        <div className="relative text-center mb-8">
          <button
            onClick={() => {
              sessionStorage.setItem("ah5_skip_setup", "1");
              router.push("/dashboard/my-agents");
            }}
            className="absolute right-0 top-0 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-gray-50 transition-colors"
          >
            Skip setup &rarr;
          </button>
          <h1 className="text-3xl font-bold text-foreground mb-2">
            Welcome to AgentHiFive 🙌
          </h1>
          <p className="text-lg text-muted">
            Safely connect <strong>OpenClaw</strong> to your AI, email, calendar, and more.
          </p>
        </div>

        {/* Progress Indicator */}
        {currentStep !== "complete" && (
          <div className="mb-8">
            <div className="flex items-center justify-center gap-2">
              <div className={`flex items-center ${currentStep === "llm" ? "text-blue-600" : "text-green-600"}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                  currentStep === "llm" ? "bg-blue-100" : "bg-green-100"
                }`}>
                  {currentStep === "llm" ? "1" : (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
                <span className="ml-2 text-sm font-medium">AI Provider</span>
              </div>

              <div className={`w-12 h-0.5 ${currentStep === "accounts" ? "bg-blue-200" : "bg-gray-200"}`} />

              <div className={`flex items-center ${currentStep === "accounts" ? "text-blue-600" : "text-gray-400"}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                  currentStep === "accounts" ? "bg-blue-100" : "bg-gray-100"
                }`}>
                  2
                </div>
                <span className="ml-2 text-sm font-medium">Accounts</span>
              </div>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
          {currentStep === "llm" && (
            <Step1LlmProvider
              agentId={agentId}
              onComplete={handleLlmComplete}
            />
          )}

          {currentStep === "accounts" && (
            <Step2ConnectAccounts
              onContinue={handleAccountsContinue}
            />
          )}

          {currentStep === "complete" && bootstrapSecret && (
            <div className="text-center">
              <div className="mb-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-4">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-foreground mb-2">You're ready! 🎉</h2>
                <p className="text-muted">Copy this enrolment key — you'll need it to register OpenClaw.</p>
              </div>

              {/* Bootstrap Secret Display */}
              <div className="mb-6 p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                <p className="text-sm font-medium text-foreground mb-2">Your Enrolment Key:</p>
                <div className="relative">
                  <div className="font-mono text-xs bg-white border border-yellow-200 rounded px-3 py-2 pr-20 break-all">
                    {bootstrapSecret}
                  </div>
                  <button
                    onClick={handleCopySecret}
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-3 py-1 text-xs font-medium rounded hover:bg-gray-100 transition-colors"
                  >
                    {copied ? (
                      <>
                        <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-green-600">Copied!</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-yellow-700 mt-2">
                  ⚠️ This key expires in 1 hour. Copy it now. Provide this to OpenClaw during setup.
                </p>
              </div>

              <div className="mb-6 text-center">
                <p className="text-sm text-muted">
                  🛡️ Standard safety rules applied — prompt injection monitoring, sensitive data filtering, full request logging. You can adjust these anytime from the dashboard.
                </p>
              </div>

              <button
                onClick={handleFinish}
                className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go to Dashboard →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
