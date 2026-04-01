/**
 * HTML email templates for transactional emails.
 * Minimal inline CSS for maximum email client compatibility.
 */

const BRAND_COLOR = "#6366f1";

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f9fafb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;padding:40px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr><td style="padding:32px 40px;">
          <div style="text-align:center;margin-bottom:24px;">
            <span style="font-size:20px;font-weight:700;color:#111827;">AgentHiFive</span>
          </div>
          ${content}
        </td></tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:#9ca3af;text-align:center;">
        AgentHiFive &mdash; Authority delegation for AI agents
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

export function resetPasswordTemplate(name: string, url: string): string {
  return layout(`
    <h1 style="font-size:18px;font-weight:600;color:#111827;margin:0 0 12px;">Reset your password</h1>
    <p style="font-size:14px;color:#4b5563;line-height:1.6;margin:0 0 24px;">
      Hi ${escapeHtml(name || "there")},<br><br>
      We received a request to reset your password. Click the button below to choose a new one.
      This link expires in 1 hour.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 32px;background-color:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">
        Reset Password
      </a>
    </div>
    <p style="font-size:12px;color:#9ca3af;line-height:1.5;margin:24px 0 0;">
      If you didn't request this, you can safely ignore this email. Your password won't change.
    </p>
  `);
}

export function verifyEmailTemplate(name: string, url: string): string {
  return layout(`
    <h1 style="font-size:18px;font-weight:600;color:#111827;margin:0 0 12px;">Verify your email</h1>
    <p style="font-size:14px;color:#4b5563;line-height:1.6;margin:0 0 24px;">
      Hi ${escapeHtml(name || "there")},<br><br>
      Thanks for signing up for AgentHiFive! Please verify your email address by clicking the button below.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 32px;background-color:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">
        Verify Email
      </a>
    </div>
    <p style="font-size:12px;color:#9ca3af;line-height:1.5;margin:24px 0 0;">
      If you didn't create an account, you can safely ignore this email.
    </p>
  `);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
