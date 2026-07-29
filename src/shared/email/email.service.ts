import config from "../../config/index.js";
import logger from "../observability/logger.js";
import type { EmailMessage, EmailProvider } from "./email.provider.js";
import { SmtpEmailProvider, isSmtpConfigured } from "./smtp-email.provider.js";

/**
 * Fallback used when no SMTP config is present (local dev, tests). Preserves
 * the pre-existing behavior of logging instead of sending, via the same
 * `sendEmail`/`EmailProvider` seam the real `SmtpEmailProvider` uses —
 * swapping providers never touches call sites.
 */
class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    // Email bodies can carry secrets (password-reset tokens, invite links).
    // Never log them in production — only the dev/test console sink does.
    if (config.env === "production") return;
    logger.debug(
      { to: message.to, subject: message.subject, text: message.text },
      "[email] no provider configured — logging instead of sending"
    );
  }
}

let provider: EmailProvider = isSmtpConfigured() ? new SmtpEmailProvider() : new ConsoleEmailProvider();

/** Test/composition-root hook for swapping in a real provider without touching call sites. */
export function setEmailProvider(next: EmailProvider): void {
  provider = next;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  try {
    await provider.send(message);
  } catch (err) {
    logger.error({ err, to: message.to }, "Failed to send email");
  }

  // Fail loud (in logs, not to the caller — callers must never block or error
  // out just because email delivery isn't configured yet) so this doesn't
  // stay silently broken in production the way it did before: previously
  // nothing was logged at all outside dev, so there was no signal that
  // password-reset emails were never actually being delivered.
  if (config.env === "production" && provider instanceof ConsoleEmailProvider) {
    logger.warn(
      { to: message.to, subject: message.subject },
      "No email provider configured — this email was not delivered"
    );
  }
}

export async function sendPasswordResetEmail(email: string, resetToken: string): Promise<void> {
  const resetUrl = `${config.frontendUrl[0]}/reset-password?token=${resetToken}`;
  await sendEmail({
    to: email,
    subject: "Reset your password",
    text: `Use this link to reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.`,
  });
}
