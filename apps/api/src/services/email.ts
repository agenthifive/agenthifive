/**
 * Email service — pluggable transport with environment-based switching.
 *
 * - "acs":      Azure Communication Services SDK (prod — connection string)
 * - "smtp":     Generic SMTP relay via Nodemailer
 * - "ethereal": Nodemailer Ethereal fake SMTP (dev — preview URLs in console)
 * - "noop":     Log only, no send (CI/test — default)
 */
import type { Transporter } from "nodemailer";
import type { EmailClient as AcsEmailClient } from "@azure/communication-email";

/** Logger interface matching Fastify's logger (or any compatible logger). */
interface EmailLogger {
  info: (...args: unknown[]) => void;
}

const defaultLogger: EmailLogger = {
  info: (...args: unknown[]) => console.log("[email]", ...args),
};

let log: EmailLogger = defaultLogger;
let transport: Transporter | null = null;
let acsClient: AcsEmailClient | null = null;
let fromAddress: string;

const provider = process.env["EMAIL_PROVIDER"] ?? "noop";

export function setEmailLogger(logger: EmailLogger) {
  log = logger;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  switch (provider) {
    case "acs":
      return sendViaAcs(to, subject, html);
    case "smtp":
      return sendViaSmtp(to, subject, html);
    case "ethereal":
      return sendViaEthereal(to, subject, html);
    default:
      log?.info({ to, subject }, "[email:noop] would send email");
  }
}

async function sendViaAcs(to: string, subject: string, html: string) {
  if (!acsClient) {
    const { EmailClient } = await import("@azure/communication-email");
    const connectionString = process.env["ACS_CONNECTION_STRING"];
    if (!connectionString) throw new Error("ACS_CONNECTION_STRING not set");
    acsClient = new EmailClient(connectionString);
    fromAddress = process.env["EMAIL_FROM"] ?? "DoNotReply@agenthifive.com";
  }
  const poller = await acsClient.beginSend({
    senderAddress: fromAddress,
    content: { subject, html },
    recipients: { to: [{ address: to }] },
  });
  await poller.pollUntilDone();
  log?.info({ to, subject }, "[email:acs] sent");
}

async function sendViaSmtp(to: string, subject: string, html: string) {
  if (!transport) {
    const nodemailer = await import("nodemailer");
    transport = nodemailer.default.createTransport({
      host: process.env["SMTP_HOST"],
      port: Number(process.env["SMTP_PORT"] ?? 587),
      secure: false, // STARTTLS
      auth: {
        user: process.env["SMTP_USERNAME"]!,
        pass: process.env["SMTP_PASSWORD"]!,
      },
    });
    fromAddress = process.env["EMAIL_FROM"] ?? "noreply@agenthifive.com";
  }
  await transport.sendMail({ from: fromAddress, to, subject, html });
  log?.info({ to, subject }, "[email:smtp] sent");
}

async function sendViaEthereal(to: string, subject: string, html: string) {
  const nodemailer = await import("nodemailer");
  if (!transport) {
    const account = await nodemailer.default.createTestAccount();
    transport = nodemailer.default.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    fromAddress = account.user;
    log?.info(
      { user: account.user },
      "[email:ethereal] test account created",
    );
  }
  const info = await transport.sendMail({ from: fromAddress, to, subject, html });
  log?.info(
    `[email:ethereal] Preview: ${nodemailer.default.getTestMessageUrl(info)}`,
  );
}
