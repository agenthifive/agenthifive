import type { CredentialProvider, CredentialQuery, CredentialResult } from "./types.js";

/**
 * Default credential provider — delegates to existing local resolution.
 * This is a pass-through that preserves 100% of existing behavior.
 * It exists so the rest of the code can always call credentialProvider.resolve()
 * without checking whether a provider is configured.
 */
export class LocalCredentialProvider implements CredentialProvider {
  readonly id = "local";

  async resolve(_query: CredentialQuery): Promise<CredentialResult | null> {
    // Return null — signals "fall through to existing resolution logic".
    return null;
  }
}
