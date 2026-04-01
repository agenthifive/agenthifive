/**
 * Error thrown by the AgentHiFive SDK when an API request fails.
 */
export class AgentHiFiveError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly auditId?: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AgentHiFiveError";
  }
}
