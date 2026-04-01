export type {
  OAuthConnector,
  ProviderCapabilities,
  AuthCodeStartInput,
  AuthCodeStartOutput,
  AuthCodeExchangeInput,
} from "./types.js";

export { GoogleConnector, GOOGLE_SCOPES } from "./google.js";
export type { GoogleConnectorConfig } from "./google.js";

export { MicrosoftConnector, MICROSOFT_SCOPES } from "./microsoft.js";
export type { MicrosoftConnectorConfig } from "./microsoft.js";

export { TelegramBotProvider } from "./telegram.js";
export type {
  TelegramBotProviderConfig,
  TelegramBotInfo,
} from "./telegram.js";

// NotionConnector kept in ./notion.ts for potential future OAuth (public integrations).
// Currently Notion uses internal integrations (API key), so it's not exported.
