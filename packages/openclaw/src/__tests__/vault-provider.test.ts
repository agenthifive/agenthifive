import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultCredentialProvider } from "../../dist/vault-provider.js";
import { setCurrentSessionContext } from "../../dist/session-context.js";
import {
  initApprovedLlmApprovals,
  resetApprovedLlmApprovals,
  resetApprovedLlmApprovalsRuntimeOnlyForTest,
  storeApprovedLlmApproval,
} from "../../dist/llm-approval-state.js";

describe("vault provider auth headers", () => {
  beforeEach(() => {
    resetApprovedLlmApprovals();
    setCurrentSessionContext({ sessionKey: "agent:main:main" });
    initApprovedLlmApprovals(mkdtempSync(join(tmpdir(), "ah5-approved-llm-")));
  });

  it("adds session key and consumes one approved LLM approval id", () => {
    const provider = new VaultCredentialProvider({
      baseUrl: "https://vault.test.example.com",
      auth: { mode: "bearer", token: "ah5t_test" },
      timeoutMs: 5_000,
      cacheTtlMs: 5_000,
    });

    storeApprovedLlmApproval("agent:main:main", "apr_123");
    const runtimeStateBefore = (globalThis as Record<string, unknown>).__ah5_runtime as
      | { approvedLlmApprovals?: Record<string, string> }
      | undefined;
    assert.equal(runtimeStateBefore?.approvedLlmApprovals?.["agent:main:main"], "apr_123");

    const first = provider.buildAuthHeaders();
    assert.equal(first["Authorization"], "Bearer ah5t_test");
    assert.equal(first["x-ah5-session-key"], "agent:main:main");
    assert.equal(first["x-ah5-approval-id"], "apr_123");

    const second = provider.buildAuthHeaders();
    assert.equal(second["Authorization"], "Bearer ah5t_test");
    assert.equal(second["x-ah5-session-key"], "agent:main:main");
    assert.equal(second["x-ah5-approval-id"], undefined);

    const runtimeStateAfter = (globalThis as Record<string, unknown>).__ah5_runtime as
      | { approvedLlmApprovals?: Record<string, string> }
      | undefined;
    assert.equal(runtimeStateAfter?.approvedLlmApprovals?.["agent:main:main"], undefined);
  });

  it("reloads approved LLM approval ids from disk after a restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ah5-approved-llm-restart-"));
    initApprovedLlmApprovals(stateDir);
    storeApprovedLlmApproval("agent:main:main", "apr_restart");

    resetApprovedLlmApprovalsRuntimeOnlyForTest();
    initApprovedLlmApprovals(stateDir);

    const provider = new VaultCredentialProvider({
      baseUrl: "https://vault.test.example.com",
      auth: { mode: "bearer", token: "ah5t_test" },
      timeoutMs: 5_000,
      cacheTtlMs: 5_000,
    });

    const headers = provider.buildAuthHeaders();
    assert.equal(headers["x-ah5-approval-id"], "apr_restart");
  });
});
