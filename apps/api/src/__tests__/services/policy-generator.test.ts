import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePolicyFromTemplate } from "../../services/policy-generator.ts";

describe("Policy Generator", () => {
  it("generates PII redaction response rules for gmail-read standard", () => {
    const policy = generatePolicyFromTemplate("gmail-read", "standard");

    assert.ok(policy.rules.response.length > 0, "should have response rules");
    const piiRule = policy.rules.response.find((r) => r.label?.includes("PII"));
    assert.ok(piiRule, "should have a PII redaction rule");
    assert.ok(piiRule.filter?.redact, "PII rule should have redact patterns");
    const redactTypes = piiRule.filter!.redact!.map((r: { type: string }) => r.type);
    // Group aliases cover individual types: contact (email, phone), financial (credit_card, iban), identity (ssn, etc.)
    assert.ok(redactTypes.includes("contact"), "should redact contact info (email, phone)");
    assert.ok(redactTypes.includes("financial"), "should redact financial data (credit cards, IBAN)");
    assert.ok(redactTypes.includes("identity"), "should redact identity docs (SSN, tax IDs)");
  });

  it("generates request rules for telegram standard", () => {
    const policy = generatePolicyFromTemplate("telegram", "standard");

    assert.ok(policy.rules.request.length > 0, "should have request rules");
    assert.ok(policy.rules.response.length > 0, "should have response rules");
  });

  it("generates base request rules for minimal tier", () => {
    const policy = generatePolicyFromTemplate("gmail-read", "minimal");

    // Read-only minimal: base rules allow reads and block writes (no guard-specific rules)
    assert.equal(policy.rules.request.length, 2, "minimal read should have 2 base request rules");
    assert.equal(policy.rules.request[0]!.action, "allow");
    assert.equal(policy.rules.request[1]!.action, "deny");
    assert.equal(policy.rules.response.length, 0, "minimal should have no response rules");
  });

  it("generates correct base rules for manage templates by tier", () => {
    const minimal = generatePolicyFromTemplate("gmail-manage", "minimal");
    const standard = generatePolicyFromTemplate("gmail-manage", "standard");
    const strict = generatePolicyFromTemplate("gmail-manage", "strict");

    // Minimal manage: allow reads + allow writes (from gmailManagePresets)
    const minAllowReads = minimal.rules.request.find((r) => r.label === "Allow all reads");
    const minAllowWrites = minimal.rules.request.find((r) => r.label === "Allow writes");
    assert.ok(minAllowReads, "minimal manage should have 'Allow all reads' rule");
    assert.ok(minAllowWrites, "minimal manage should have 'Allow writes' rule");
    assert.equal(minAllowReads!.action, "allow");
    assert.equal(minAllowWrites!.action, "allow");

    // Standard manage: fine-grained rules from gmailManagePresets
    const stdAllow = standard.rules.request.find((r) => r.action === "allow");
    const stdApprove = standard.rules.request.find((r) => r.action === "require_approval");
    assert.ok(stdAllow, "standard manage should have an allow rule");
    assert.ok(stdApprove, "standard manage should have a require_approval rule");

    // Strict manage: fine-grained rules from gmailManagePresets
    const strictAllow = strict.rules.request.find((r) => r.action === "allow");
    const strictApprove = strict.rules.request.find((r) => r.action === "require_approval");
    assert.ok(strictAllow, "strict manage should have an allow rule");
    assert.ok(strictApprove, "strict manage should have a require_approval rule");

    // All templated policies have stepUpApproval: "never" (rules handle access control)
    assert.equal(minimal.stepUpApproval, "never");
    assert.equal(standard.stepUpApproval, "never");
    assert.equal(strict.stepUpApproval, "never");
  });

  it("generates prompt injection guards for anthropic strict", () => {
    const policy = generatePolicyFromTemplate("anthropic-messages", "strict");

    assert.ok(policy.rules.request.length >= 2, "should have multiple request rules");
    const injectionRule = policy.rules.request.find((r) => r.label?.includes("injection"));
    assert.ok(injectionRule, "should have a prompt injection rule");
  });

  it("includes the OpenAI responses endpoint in generated allowlists", () => {
    const standard = generatePolicyFromTemplate("openai", "standard");
    const strict = generatePolicyFromTemplate("openai", "strict");

    assert.equal(standard.allowlists.length, 1);
    assert.ok(standard.allowlists[0]?.pathPatterns.includes("/v1/responses"));
    assert.equal(strict.allowlists.length, 1);
    assert.ok(strict.allowlists[0]?.pathPatterns.includes("/v1/responses"));
  });

  it("includes Gemini streaming endpoints in generated allowlists and rules", () => {
    const minimal = generatePolicyFromTemplate("gemini", "minimal");
    const standard = generatePolicyFromTemplate("gemini", "standard");
    const strict = generatePolicyFromTemplate("gemini", "strict");

    assert.equal(minimal.allowlists.length, 1);
    assert.ok(minimal.allowlists[0]?.pathPatterns.includes("/v1beta/models/*:streamGenerateContent"));

    assert.equal(standard.allowlists.length, 1);
    assert.ok(standard.allowlists[0]?.pathPatterns.includes("/v1beta/models/*:streamGenerateContent"));

    assert.equal(strict.allowlists.length, 1);
    assert.ok(strict.allowlists[0]?.pathPatterns.includes("/v1beta/models/*:generateContent"));

    const standardGenerateRule = standard.rules.request.find((r) => r.label === "Allow generate content");
    assert.equal(standardGenerateRule?.match?.urlPattern, ":(generate|streamGenerate)Content$");

    const strictApprovalRule = strict.rules.request.find((r) => r.label === "Approve all content generation");
    assert.equal(strictApprovalRule?.match?.urlPattern, ":(generate|streamGenerate)Content$");
  });
});
