import nodemailer, { type Transporter } from "nodemailer";
import config from "../../config/index.js";
import type { EmailMessage, EmailProvider } from "./email.provider.js";

export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;

  constructor(transporter?: Transporter) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: config.smtpUser
          ? {
              user: config.smtpUser,
              pass: config.smtpPassword,
            }
          : undefined,
      });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: config.smtpFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/** True when enough SMTP config is present to attempt a real send. */
export function isSmtpConfigured(): boolean {
  return Boolean(config.smtpHost);
}
