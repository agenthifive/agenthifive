/**
 * Telegram Bot Provider
 *
 * Telegram bots use a bot token from @BotFather, not OAuth.
 * This provider validates and stores bot tokens.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramBotInfo {
  id: number;
  isBot: boolean;
  firstName: string;
  username: string;
}

export interface TelegramBotProviderConfig {
  /** Optional custom API base URL for testing */
  apiBase?: string;
}

export class TelegramBotProvider {
  private readonly apiBase: string;

  constructor(config?: TelegramBotProviderConfig) {
    this.apiBase = config?.apiBase ?? TELEGRAM_API_BASE;
  }

  /**
   * Validate a bot token by calling the Telegram getMe API.
   * Returns bot info on success, throws on invalid token.
   */
  async validateBotToken(botToken: string): Promise<TelegramBotInfo> {
    const url = `${this.apiBase}/bot${botToken}/getMe`;

    const response = await fetch(url, { method: "GET" });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Telegram getMe failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username: string;
      };
      description?: string;
    };

    if (!data.ok || !data.result) {
      throw new Error(
        `Telegram getMe returned error: ${data.description ?? "unknown"}`,
      );
    }

    return {
      id: data.result.id,
      isBot: data.result.is_bot,
      firstName: data.result.first_name,
      username: data.result.username,
    };
  }

  /**
   * Store a bot token after validation.
   * Returns the bot info for display in the UI.
   * The caller is responsible for encrypting and persisting the token.
   */
  async storeBotToken(botToken: string): Promise<{
    botInfo: TelegramBotInfo;
    token: string;
  }> {
    const botInfo = await this.validateBotToken(botToken);
    return { botInfo, token: botToken };
  }
}
