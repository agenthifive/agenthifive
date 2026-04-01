"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface Step1LlmProviderProps {
  agentId: string;
  onComplete: (provider: string, credential: string, connectionId: string) => void;
}

type Provider = "anthropic" | "openai" | "google" | "openrouter";

const PROVIDERS: Array<{
  id: Provider;
  name: string;
  icon: string;
  docsUrl: string;
  inputLabel: string;
  inputType: "api_key";
  placeholder: string;
}> = [
  {
    id: "anthropic",
    name: "Claude",
    icon: "🧠",
    docsUrl: "https://console.anthropic.com/settings/keys",
    inputLabel: "API Key",
    inputType: "api_key",
    placeholder: "sk-ant-...",
  },
  {
    id: "openai",
    name: "ChatGPT",
    icon: "🤖",
    docsUrl: "https://platform.openai.com/api-keys",
    inputLabel: "API Key",
    inputType: "api_key",
    placeholder: "sk-...",
  },
  {
    id: "google",
    name: "Gemini",
    icon: "✨",
    docsUrl: "https://aistudio.google.com/app/apikey",
    inputLabel: "API Key",
    inputType: "api_key",
    placeholder: "AIza...",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🔀",
    docsUrl: "https://openrouter.ai/keys",
    inputLabel: "API Key",
    inputType: "api_key",
    placeholder: "sk-or-...",
  },
];

export default function Step1LlmProvider({ agentId, onComplete }: Step1LlmProviderProps) {
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [credential, setCredential] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProviderConfig = PROVIDERS.find((p) => p.id === selectedProvider);

  const handleProviderSelect = (providerId: Provider) => {
    setSelectedProvider(providerId);
    setCredential("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedProvider || !credential) {
      setError("Please select a provider and enter your credentials");
      return;
    }

    setLoading(true);

    try {
      // Map provider IDs to the service IDs expected by the API
      const providerToServiceMap: Record<string, { provider: string; service: string }> = {
        anthropic: { provider: "anthropic", service: "anthropic-messages" },
        openai: { provider: "openai", service: "openai" },
        google: { provider: "gemini", service: "gemini" },
        openrouter: { provider: "openrouter", service: "openrouter" },
      };

      const mapping = providerToServiceMap[selectedProvider];

      if (!mapping) {
        throw new Error(`Unsupported provider: ${selectedProvider}`);
      }

      // Map service to action template ID for LLM providers
      const serviceToActionTemplate: Record<string, string> = {
        "anthropic-messages": "anthropic-messages",
        "openai": "openai",
        "gemini": "gemini",
      };

      const res = await apiFetch("/connections/api-key", {
        method: "POST",
        body: JSON.stringify({
          provider: mapping.provider,
          service: mapping.service,
          apiKey: credential,
          label: `${selectedProviderConfig?.name || mapping.provider} LLM`,
        }),
      });

      if (!res.ok) {
        const errorData = (await res.json()) as { error: string };
        throw new Error(errorData.error || "Failed to connect LLM provider");
      }

      const data = (await res.json()) as {
        connection: { id: string; label: string };
      };

      // Automatically create a Standard policy for this LLM connection
      const actionTemplateId = serviceToActionTemplate[mapping.service];
      const policyRes = await apiFetch("/policies", {
        method: "POST",
        body: JSON.stringify({
          agentId: agentId,
          connectionId: data.connection.id,
          actionTemplateId: actionTemplateId, // Include action template for guards
          policyTier: "standard", // Standard tier includes prompt injection & PII guards
          allowedModels: ["B"], // Model B (protected access) for LLM connections
          defaultMode: "read_only",
          stepUpApproval: "risk_based",
        }),
      });

      if (!policyRes.ok) {
        const policyError = (await policyRes.json()) as { error: string };
        throw new Error(policyError.error || "Failed to create policy");
      }

      onComplete(mapping.provider, credential, data.connection.id);
    } catch (err) {
      console.error("Error connecting LLM:", err);
      setError(err instanceof Error ? err.message : "Failed to connect");
      setLoading(false);
    }
  };

  const canContinue = selectedProvider && credential.trim().length > 0;

  return (
    <div>
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">
          Which AI should OpenClaw think with?
        </h2>
        <p className="text-sm text-muted">
          Pick a provider and add your API key. We'll store it securely — OpenClaw never sees it directly.
        </p>
      </div>

      {/* Safety Callout */}
      <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
        <p className="text-sm text-blue-900">
          🛡️ AgentHiFive keeps your API key in an encrypted vault, monitors for prompt injection, and filters sensitive data before it reaches the AI provider. Every request is logged and you can cut access instantly.
        </p>
      </div>

      {/* Provider Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => handleProviderSelect(provider.id)}
            className={`rounded-lg border-2 p-4 text-left transition-all ${
              selectedProvider === provider.id
                ? "border-blue-500 bg-blue-50 hover:shadow-md"
                : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-md"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="text-3xl opacity-60">{provider.icon}</span>
              <div className="flex-1">
                <div className="text-sm font-semibold text-foreground">{provider.name}</div>
                {selectedProvider === provider.id && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-blue-600">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Selected
                  </div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Credential Input */}
      {selectedProvider && selectedProviderConfig && (
        <form onSubmit={handleSubmit}>
          <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-6 space-y-4">
            {/* API Key */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="credential" className="block text-sm font-medium text-foreground">
                  {selectedProviderConfig.inputLabel}
                </label>
                {selectedProviderConfig.docsUrl && (
                  <a
                    href={selectedProviderConfig.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Get your key →
                  </a>
                )}
              </div>
              <input
                id="credential"
                type="text"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={selectedProviderConfig.placeholder}
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-muted">
                Your key is encrypted and stored securely in the vault
              </p>
            </div>

            {/* Error Display */}
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Continue Button */}
            <button
              type="submit"
              disabled={!canContinue || loading}
              className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Connecting..." : "Continue"}
            </button>
          </div>
        </form>
      )}

      {/* Help Text */}
      {!selectedProvider && (
        <div className="mt-6 rounded-lg border border-border bg-gray-50 p-4">
          <p className="text-sm text-muted">
            🔒 Your key is encrypted and never exposed to the agent.
          </p>
        </div>
      )}
    </div>
  );
}
