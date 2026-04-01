import type { CredentialProvider, CredentialQuery, CredentialResult } from "./types.js";

/**
 * Chainable resolver — tries providers in order.
 * Used when credentials.provider = "vault+local" (try vault first, fall back to local).
 */
export class ChainedCredentialProvider implements CredentialProvider {
  readonly id = "chained";
  private providers: CredentialProvider[];

  constructor(providers: CredentialProvider[]) {
    this.providers = providers;
  }

  async resolve(query: CredentialQuery): Promise<CredentialResult | null> {
    for (const p of this.providers) {
      const result = await p.resolve(query);
      if (result) {
        return result;
      }
    }
    return null;
  }
}
