import type { FastifyInstance } from "fastify";
import {
  ALLOWLIST_TEMPLATES,
  GUARD_CATEGORIES,
  getGuardsForProvider,
  getPresetsForProvider,
  getPresetsForService,
  getPresetsForScopes,
  getPresetsForActionTemplate,
  getTemplatesForProvider,
  SERVICE_IDS,
  isValidActionTemplateId,
  getActionTemplatesForService,
  type PolicyTier,
} from "@agenthifive/contracts";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, policies } from "../db/schema/index.js";
import { generatePolicyFromTemplate } from "../services/policy-generator.js";

const providerEnum = ["google", "microsoft", "telegram", "slack", "anthropic", "openai", "gemini", "openrouter", "notion", "trello", "jira", "email"] as const;

const serviceEnum = [
  "google-gmail",
  "google-calendar",
  "google-drive",
  "google-sheets",
  "google-docs",
  "google-contacts",
  "microsoft-teams",
  "microsoft-outlook-mail",
  "microsoft-outlook-calendar",
  "microsoft-onedrive",
  "microsoft-outlook-contacts",
  "telegram",
  "slack",
  "anthropic-messages",
  "openai",
  "gemini",
  "openrouter",
  "notion",
  "trello",
  "jira",
] as const;

// Combined enum without duplicates (for schema validation)
const providerOrServiceEnum = [
  ...providerEnum,
  "google-gmail",
  "google-calendar",
  "google-drive",
  "google-sheets",
  "google-docs",
  "google-contacts",
  "microsoft-teams",
  "microsoft-outlook-mail",
  "microsoft-outlook-calendar",
  "microsoft-onedrive",
  "microsoft-outlook-contacts",
  "anthropic-messages",
  "email-imap",
] as const;

export default async function templateRoutes(fastify: FastifyInstance) {
  /**
   * GET /templates/:provider
   * Returns allowlist templates for a given provider.
   * Templates are stored in code (not database).
   */
  fastify.get<{ Params: { provider: string } }>(
    "/templates/:provider",
    {
      schema: {
        tags: ["Templates"],
        summary: "Get allowlist templates for provider",
        description: "Returns pre-configured allowlist templates for a given provider (google, microsoft, telegram). Templates are stored in code.",
        params: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: [...providerEnum], description: "Provider name" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              templates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    provider: { type: "string" },
                    sensitive: { type: "boolean" },
                    allowlists: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: true,
                        properties: {
                          baseUrl: { type: "string" },
                          methods: { type: "array", items: { type: "string" } },
                          pathPatterns: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const templates = ALLOWLIST_TEMPLATES[provider];

      if (!templates) {
        return reply.code(200).send({ templates: [] });
      }

      return reply.send({ templates });
    },
  );

  /**
   * GET /templates/:provider/rules
   * Returns rule presets and individual rule templates for a provider or service.
   * Presets are named bundles (minimal/standard/strict) that set request + response rules.
   * Templates are individual rules that can be applied à la carte.
   *
   * IMPORTANT: This endpoint now accepts both provider names (e.g., "google") and service IDs (e.g., "google-gmail").
   * Service IDs provide service-specific rules, while provider names return generic provider-level rules (deprecated).
   *
   * NEW: Supports ?connectionId=<uuid> query parameter for scope-aware presets.
   * When connectionId is provided, returns presets filtered by the connection's granted OAuth scopes.
   */
  fastify.get<{ Params: { provider: string }; Querystring: { connectionId?: string; actionTemplateId?: string } }>(
    "/templates/:provider/rules",
    {
      schema: {
        tags: ["Templates"],
        summary: "Get rule presets and templates for provider or service",
        description:
          "Returns rule presets (minimal/standard/strict bundles) and individual rule templates. " +
          "Accepts both provider names (e.g., 'google') and service IDs (e.g., 'google-gmail'). " +
          "Service IDs provide service-specific rules (recommended), while provider names return generic provider-level rules (deprecated). " +
          "Pass ?connectionId=<uuid> to get scope-aware presets based on granted OAuth scopes. " +
          "Pass ?actionTemplateId=<id> to get presets for a specific action template (e.g., 'trello-read' vs 'trello-manage').",
        params: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: {
              type: "string",
              enum: [...providerOrServiceEnum],
              description: "Provider name or service ID. Use service ID for service-specific rules (recommended).",
            },
          },
        },
        querystring: {
          type: "object",
          properties: {
            connectionId: {
              type: "string",
              format: "uuid",
              description: "Optional connection ID to get scope-aware presets",
            },
            actionTemplateId: {
              type: "string",
              description: "Optional action template ID (e.g., 'trello-read') to get template-specific presets",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              presets: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    rules: { type: "object", additionalProperties: true },
                    recommended: {
                      type: "object",
                      properties: {
                        defaultMode: { type: "string" },
                        stepUpApproval: { type: "string" },
                      },
                    },
                    rateLimitLabel: { type: "string" },
                    features: { type: "array", items: { type: "string" } },
                  },
                },
              },
              templates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    provider: { type: "string" },
                    preset: { type: "string" },
                    requestRules: { type: "array", items: { type: "object", additionalProperties: true } },
                    responseRules: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { provider } = request.params;
      const { connectionId, actionTemplateId: queryActionTemplateId } = request.query;

      // Check if this is a service ID (e.g., "google-gmail") or a provider (e.g., "google")
      const isServiceId = SERVICE_IDS.includes(provider as any);

      let presetMap: Record<"minimal" | "standard" | "strict", any>;
      let templates: any[];

      if (isServiceId) {
        // Priority 1: Explicit actionTemplateId query param (from policy wizard during creation)
        if (queryActionTemplateId) {
          const actionPresets = getPresetsForActionTemplate(queryActionTemplateId);
          if (actionPresets) {
            presetMap = actionPresets;
          } else {
            presetMap = getPresetsForService(provider);
          }
        } else if (connectionId) {
          // Priority 2: Look up existing policy's actionTemplateId via connectionId
          const [policy] = await db.select({ actionTemplateId: policies.actionTemplateId })
            .from(policies)
            .where(eq(policies.connectionId, connectionId))
            .limit(1);

          if (policy?.actionTemplateId) {
            const actionPresets = getPresetsForActionTemplate(policy.actionTemplateId);
            if (actionPresets) {
              presetMap = actionPresets;
            } else {
              const connection = await db.select()
                .from(connections)
                .where(eq(connections.id, connectionId))
                .limit(1)
                .then(rows => rows[0]);
              presetMap = connection
                ? getPresetsForScopes(provider, connection.grantedScopes)
                : getPresetsForService(provider);
            }
          } else {
            const connection = await db.select()
              .from(connections)
              .where(eq(connections.id, connectionId))
              .limit(1)
              .then(rows => rows[0]);
            presetMap = connection
              ? getPresetsForScopes(provider, connection.grantedScopes)
              : getPresetsForService(provider);
          }
        } else {
          // No connectionId - use standard service-level presets
          presetMap = getPresetsForService(provider);
        }

        // For templates, we still use provider-level for now (can be enhanced later)
        const serviceProvider = provider.split("-")[0]!;
        templates = getTemplatesForProvider(serviceProvider);
      } else {
        // Use provider-level presets (DEPRECATED)
        presetMap = getPresetsForProvider(provider);
        templates = getTemplatesForProvider(provider);
      }

      const presets = [presetMap.minimal, presetMap.standard, presetMap.strict];

      return { presets, templates };
    },
  );

  /**
   * GET /templates/:provider/guards
   * Returns contextual guards for a provider, organized by action category.
   * Guards are toggleable security rules (profanity filter, PII guard, etc.)
   * that produce provider-specific request/response rules when enabled.
   */
  fastify.get<{ Params: { provider: string } }>(
    "/templates/:provider/guards",
    {
      schema: {
        tags: ["Templates"],
        summary: "Get contextual guards for provider",
        description:
          "Returns contextual security guards organized by action category (messaging, file sharing, calendar, etc.). " +
          "Each guard is a toggleable rule that produces provider-specific request/response rules when enabled.",
        params: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", enum: [...providerEnum], description: "Provider name" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              categories: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
              guards: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    category: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    risk: { type: "string", enum: ["low", "medium", "high"] },
                    presetTier: { type: "string", enum: ["standard", "strict"] },
                    providers: { type: "array", items: { type: "string" } },
                    requestRules: { type: "array", items: { type: "object", additionalProperties: true } },
                    responseRules: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { provider } = request.params;
      const guards = getGuardsForProvider(provider);
      return { categories: GUARD_CATEGORIES, guards };
    },
  );

  /**
   * GET /templates/:actionTemplateId/config
   * Returns the full generated policy config (allowlists, rate limits, time windows)
   * for a given action template and tier. Used by the policy editor to populate
   * settings when the user changes the security preset.
   */
  fastify.get<{
    Params: { actionTemplateId: string };
    Querystring: { tier: string; timezone?: string };
  }>(
    "/templates/:actionTemplateId/config",
    {
      schema: {
        tags: ["Templates"],
        summary: "Preview generated policy config for a template and tier",
        description:
          "Returns the full generated policy configuration (allowlists, rate limits, time windows, rules) " +
          "for a given action template ID and tier. Used to preview what a tier change will produce.",
        params: {
          type: "object",
          required: ["actionTemplateId"],
          properties: {
            actionTemplateId: { type: "string", description: "Action template ID (e.g., gmail-read)" },
          },
        },
        querystring: {
          type: "object",
          required: ["tier"],
          properties: {
            tier: { type: "string", enum: ["strict", "standard", "minimal"] },
            timezone: { type: "string", default: "UTC" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              allowlists: { type: "array", items: { type: "object", additionalProperties: true } },
              rateLimits: { type: "object", additionalProperties: true },
              timeWindows: { type: "array", items: { type: "object", additionalProperties: true } },
              stepUpApproval: { type: "string" },
              defaultMode: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      let { actionTemplateId } = request.params;
      const { tier, timezone } = request.query;

      // Also accept service IDs (e.g., "google-gmail") — resolve to first matching action template
      if (!isValidActionTemplateId(actionTemplateId)) {
        const serviceTemplates = getActionTemplatesForService(actionTemplateId);
        if (serviceTemplates.length > 0) {
          actionTemplateId = serviceTemplates[0]!.id;
        } else {
          return reply.code(400).send({ error: `Unknown action template or service: ${actionTemplateId}` });
        }
      }

      try {
        const config = generatePolicyFromTemplate(
          actionTemplateId,
          tier as PolicyTier,
          timezone || "UTC",
        );

        // Derive defaultMode from tier
        const defaultMode = tier === "strict" ? "custom" : tier === "standard" ? "read_write" : "read_only";

        return {
          allowlists: config.allowlists,
          rateLimits: config.rateLimits,
          timeWindows: config.timeWindows,
          stepUpApproval: config.stepUpApproval,
          defaultMode,
        };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "Failed to generate template config",
        });
      }
    },
  );
}
