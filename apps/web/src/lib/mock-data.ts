export { ACTION_TEMPLATES, type ActionTemplate } from "@agenthifive/contracts";

/** Shape of an agent permission request from the API */
export interface PendingPermissionRequest {
  id: string;
  agentId: string;
  agentName: string;
  actionTemplateId: string;
  reason: string;
  requestedAt: string;
}
