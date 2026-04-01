import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTemplate,
  getPolicyTemplates,
  getDefaultTemplate,
  getPolicyTemplate,
  POLICY_TEMPLATES,
  type PolicyTemplateWithRef,
  type PolicyTemplate,
  type PolicyTier,
} from "../policy-templates.js";

describe("Policy Templates", () => {
  describe("resolveTemplate()", () => {
    it("should return template as-is when no baseTemplate reference", () => {
      const template: PolicyTemplateWithRef = {
        tier: "standard",
        name: "Test",
        description: "Test template",
        icon: "🔒",
        guards: [],
      };

      const resolved = resolveTemplate(template);

      assert.equal(resolved.tier, "standard");
      assert.equal(resolved.name, "Test");
      assert.equal(resolved.description, "Test template");
      assert.equal(resolved.icon, "🔒");
      assert.deepEqual(resolved.guards, []);
      // recommended should not be present when undefined
      assert.equal(resolved.recommended, undefined);
    });

    it("should inherit from base template when baseTemplate is specified", () => {
      // Use synthetic baseTemplate since no real templates use it anymore
      const originalTemplates = { ...POLICY_TEMPLATES };
      POLICY_TEMPLATES["_test-base"] = {
        strict: {
          tier: "strict",
          name: "Strict",
          description: "Base strict",
          icon: "🔒",
          guards: ["cs-profanity", "cs-pii-outbound"],
        },
        standard: {
          tier: "standard",
          name: "Standard",
          description: "Base standard",
          icon: "🛡️",
          guards: ["cs-profanity"],
        },
        minimal: {
          tier: "minimal",
          name: "Minimal",
          description: "Base minimal",
          icon: "⚡",
          guards: [],
        },
      };

      try {
        const childTemplate: PolicyTemplateWithRef = {
          tier: "strict",
          name: "Strict",
          description: "Child strict",
          icon: "🔒",
          baseTemplate: "_test-base:strict",
          guards: ["cs-profanity", "dest-delete-protect"],
        };

        const resolved = resolveTemplate(childTemplate);

        assert.equal(resolved.tier, "strict");
        assert.equal(resolved.name, "Strict");
        assert.equal(resolved.icon, "🔒");

        // Should have overridden guards
        assert.deepEqual(resolved.guards, ["cs-profanity", "dest-delete-protect"]);
      } finally {
        Object.keys(POLICY_TEMPLATES).forEach((key) => {
          if (!(key in originalTemplates)) {
            delete POLICY_TEMPLATES[key];
          }
        });
      }
    });

    it("should handle outlook-manage as standalone template", () => {
      const resolved = resolveTemplate(POLICY_TEMPLATES["outlook-manage"]!.standard);

      assert.equal(resolved.tier, "standard");
      assert.equal(resolved.recommended, true);
      assert.ok(Array.isArray(resolved.guards));
    });

    it("should throw error for invalid baseTemplate format", () => {
      const invalidTemplate: PolicyTemplateWithRef = {
        tier: "standard",
        name: "Invalid",
        description: "Invalid template",
        icon: "🔒",
        baseTemplate: "invalid-format", // Missing colon separator
      };

      assert.throws(
        () => resolveTemplate(invalidTemplate),
        /Invalid baseTemplate format/
      );
    });

    it("should throw error when base template not found", () => {
      const invalidTemplate: PolicyTemplateWithRef = {
        tier: "standard",
        name: "Invalid",
        description: "Invalid template",
        icon: "🔒",
        baseTemplate: "nonexistent:standard",
      };

      assert.throws(
        () => resolveTemplate(invalidTemplate),
        /Base template not found/
      );
    });

    it("should handle recursive base template resolution", () => {
      // Create a chain: A → B → C
      const baseTemplate: PolicyTemplateWithRef = {
        tier: "standard",
        name: "Base",
        description: "Base template",
        icon: "🔒",
        guards: ["base-guard"],
      };

      const mockTemplates: Record<string, Record<PolicyTier, PolicyTemplateWithRef>> = {
        base: {
          strict: baseTemplate,
          standard: baseTemplate,
          minimal: baseTemplate,
        },
      };

      // Temporarily add to POLICY_TEMPLATES for testing
      const originalTemplates = { ...POLICY_TEMPLATES };
      Object.assign(POLICY_TEMPLATES, mockTemplates);

      try {
        const middleTemplate: PolicyTemplateWithRef = {
          tier: "standard",
          name: "Middle",
          description: "Middle template",
          icon: "🔒",
          baseTemplate: "base:standard",
          guards: ["base-guard", "middle-guard"],
        };

        // Add middle to templates (all three tiers)
        POLICY_TEMPLATES["middle"] = {
          strict: middleTemplate,
          standard: middleTemplate,
          minimal: middleTemplate,
        };

        const childTemplate: PolicyTemplateWithRef = {
          tier: "standard",
          name: "Child",
          description: "Child template",
          icon: "🔒",
          baseTemplate: "middle:standard",
          guards: ["child-guard"],
        };

        const resolved = resolveTemplate(childTemplate);

        assert.equal(resolved.name, "Child");
        assert.deepEqual(resolved.guards, ["child-guard"]);
      } finally {
        // Restore original templates
        Object.keys(POLICY_TEMPLATES).forEach((key) => {
          if (!(key in originalTemplates)) {
            delete POLICY_TEMPLATES[key];
          }
        });
      }
    });
  });

  describe("getPolicyTemplates()", () => {
    it("should return resolved templates for gmail-manage", () => {
      const templates = getPolicyTemplates("gmail-manage");

      assert.equal(templates.length, 3);
      assert.equal(templates[0]!.tier, "strict");
      assert.equal(templates[1]!.tier, "standard");
      assert.equal(templates[2]!.tier, "minimal");

      // All should be fully resolved
      templates.forEach((t) => {
        assert.ok(Array.isArray(t.guards));
      });
    });

    it("should return resolved templates for outlook-manage", () => {
      const templates = getPolicyTemplates("outlook-manage");

      assert.equal(templates.length, 3);

      const standard = templates.find((t) => t.tier === "standard");
      assert.ok(standard);
      assert.equal(standard.recommended, true);
    });

    it("should return fallback template for unknown action", () => {
      const templates = getPolicyTemplates("unknown-action");

      assert.equal(templates.length, 1);
      assert.equal(templates[0]!.tier, "standard");
      assert.equal(templates[0]!.name, "Standard");
      assert.deepEqual(templates[0]!.guards, []);
    });

    it("should return templates for standalone action (gmail-manage)", () => {
      const templates = getPolicyTemplates("gmail-manage");

      assert.equal(templates.length, 3);

      const strict = templates.find((t) => t.tier === "strict");
      assert.ok(strict);
      assert.ok(strict.guards.includes("dest-delete-protect"));
    });
  });

  describe("getDefaultTemplate()", () => {
    it("should return standard tier for gmail-manage", () => {
      const template = getDefaultTemplate("gmail-manage");

      assert.equal(template.tier, "standard");
      assert.equal(template.recommended, true);
      assert.equal(template.name, "Standard");
    });

    it("should return standard tier for outlook-manage", () => {
      const template = getDefaultTemplate("outlook-manage");

      assert.equal(template.tier, "standard");
      assert.equal(template.recommended, true);
    });

    it("should return fallback for unknown action", () => {
      const template = getDefaultTemplate("unknown-action");

      assert.equal(template.tier, "standard");
      assert.equal(template.name, "Standard");
    });
  });

  describe("getPolicyTemplate()", () => {
    it("should return specific tier for gmail-manage", () => {
      const strict = getPolicyTemplate("gmail-manage", "strict");
      const standard = getPolicyTemplate("gmail-manage", "standard");
      const minimal = getPolicyTemplate("gmail-manage", "minimal");

      assert.ok(strict);
      assert.equal(strict.tier, "strict");
      assert.ok(strict.guards.includes("dest-delete-protect"));

      assert.ok(standard);
      assert.equal(standard.tier, "standard");
      assert.equal(standard.recommended, true);

      assert.ok(minimal);
      assert.equal(minimal.tier, "minimal");
    });

    it("should return null for unknown action", () => {
      const template = getPolicyTemplate("unknown-action", "standard");
      assert.equal(template, null);
    });
  });

  describe("Template Restriction Correctness", () => {
    it("outlook-manage should have send-approval guard", () => {
      const outlookSendStrict = getPolicyTemplate("outlook-manage", "strict");

      assert.ok(outlookSendStrict);
      assert.ok(
        outlookSendStrict.guards.includes("msg-send-approval"),
        "outlook-manage strict should require message send approval"
      );
    });

    it("strict tier should be more restrictive than minimal tier", () => {
      const strict = getPolicyTemplate("gmail-manage", "strict");
      const minimal = getPolicyTemplate("gmail-manage", "minimal");

      assert.ok(strict);
      assert.ok(minimal);

      // Strict should have more guards
      assert.ok(
        strict.guards.length >= minimal.guards.length,
        "strict should have more guards than minimal"
      );
    });

    it("all templates should have required fields after resolution", () => {
      const actionTemplates = [
        "gmail-manage",
        "outlook-manage",
        "calendar-manage",
        "drive-manage",
        "teams-manage",
      ];

      actionTemplates.forEach((actionId) => {
        const templates = getPolicyTemplates(actionId);

        templates.forEach((template) => {
          assert.ok(template.tier, `${actionId} missing tier`);
          assert.ok(template.name, `${actionId} missing name`);
          assert.ok(template.description, `${actionId} missing description`);
          assert.ok(template.icon, `${actionId} missing icon`);
          assert.ok(Array.isArray(template.guards), `${actionId} guards not array`);
        });
      });
    });
  });
});
