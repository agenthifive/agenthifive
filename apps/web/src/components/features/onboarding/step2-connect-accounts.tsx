"use client";

import { useState } from "react";
import {
  SERVICE_CATALOG,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_LABELS,
  getServicesByCategory,
  type ServiceCategory,
} from "@agenthifive/contracts";

interface Step2ConnectAccountsProps {
  onContinue: () => void;
}

export default function Step2ConnectAccounts({
  onContinue,
}: Step2ConnectAccountsProps) {
  const [selectedCategory, setSelectedCategory] = useState<ServiceCategory>("communication");
  const [showAllAccounts, setShowAllAccounts] = useState(false);

  // Filter out LLM services - those were handled in Step 1
  const availableCategories = SERVICE_CATEGORIES.filter((cat) => cat !== "llm");

  return (
    <div>
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">
          What you can connect
        </h2>
        <p className="text-sm text-muted">
          Once you're set up, you can give OpenClaw access to any of these from your dashboard.
        </p>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-2 mb-6 border-b border-border">
        {availableCategories.map((category) => (
          <button
            key={category}
            onClick={() => {
              setSelectedCategory(category);
              setShowAllAccounts(false); // Reset expansion when changing tabs
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              selectedCategory === category
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-muted hover:text-foreground"
            }`}
          >
            {SERVICE_CATEGORY_LABELS[category]}
          </button>
        ))}
      </div>

      {/* Service Grid - Read-only preview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        {getServicesByCategory(selectedCategory)
          .filter((_, index) => {
            // For "data" category (Accounts OpenClaw can access), show only first 3 unless expanded
            if (selectedCategory === "data" && !showAllAccounts) {
              return index < 3;
            }
            return true;
          })
          .map(([serviceId, service]) => (
            <div
              key={serviceId}
              className="rounded-lg border-2 border-gray-200 bg-white p-4"
            >
              <div className="flex items-start gap-3">
                <span className="text-3xl opacity-60">{service.icon}</span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-foreground mb-1">
                    {service.displayName}
                  </div>
                  <div className="text-xs text-muted">
                    {service.description}
                  </div>
                </div>
              </div>
            </div>
          ))}
      </div>

      {/* Show All Link - Only for data category */}
      {selectedCategory === "data" && !showAllAccounts && (
        <div className="mb-6 text-center">
          <button
            type="button"
            onClick={() => setShowAllAccounts(true)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            Show all available accounts →
          </button>
        </div>
      )}

      {/* Info Callout */}
      <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
        <p className="text-sm text-blue-900">
          💡 You can connect these from your dashboard anytime — or wait until OpenClaw requests access to a specific account.
        </p>
      </div>

      {/* Action Button */}
      <button
        type="button"
        onClick={onContinue}
        className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
      >
        Finish setup →
      </button>

      {/* Helper Text */}
      <div className="mt-6 rounded-lg border border-border bg-gray-50 p-4">
        <p className="text-sm text-muted">
          🔒 All accounts are encrypted and protected by safety rules.
        </p>
      </div>
    </div>
  );
}
