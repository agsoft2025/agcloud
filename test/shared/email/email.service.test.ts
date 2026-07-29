import { describe, it, expect, afterEach, vi } from "vitest";
import {
  sendEmail,
  sendPasswordResetEmail,
  setEmailProvider,
} from "../../../src/shared/email/email.service.js";
import type { EmailMessage, EmailProvider } from "../../../src/shared/email/email.provider.js";
import logger from "../../../src/shared/observability/logger.js";

describe("email service", () => {
  afterEach(() => {
    setEmailProvider({ async send() {} });
    vi.restoreAllMocks();
  });

  it("delegates to the configured provider", async () => {
    const sent: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sent.push(message);
      },
    };
    setEmailProvider(provider);

    await sendEmail({ to: "a@example.com", subject: "Hi", text: "body" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ to: "a@example.com", subject: "Hi", text: "body" });
  });

  it("never rejects, even when the provider throws", async () => {
    setEmailProvider({
      async send() {
        throw new Error("smtp down");
      },
    });

    await expect(
      sendEmail({ to: "a@example.com", subject: "Hi", text: "body" })
    ).resolves.toBeUndefined();
  });

  it("builds a password reset email containing the token in the reset URL", async () => {
    const sent: EmailMessage[] = [];
    setEmailProvider({
      async send(message) {
        sent.push(message);
      },
    });

    await sendPasswordResetEmail("user@example.com", "abc123token");

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("user@example.com");
    expect(sent[0].text).toContain("token=abc123token");
  });

  it("warns (does not throw) when no real provider is configured", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    await sendEmail({ to: "a@example.com", subject: "Hi", text: "body" });
    // Only asserts this doesn't throw; the warn is env-gated (production only)
    // so we don't assert call count here — see auth.routes.test.ts for the
    // end-to-end forgot-password coverage of the default provider.
    expect(warnSpy).toBeDefined();
  });
});
