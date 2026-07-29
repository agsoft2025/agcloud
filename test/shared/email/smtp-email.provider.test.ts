import { describe, it, expect, vi } from "vitest";
import { SmtpEmailProvider } from "../../../src/shared/email/smtp-email.provider.js";

describe("SmtpEmailProvider", () => {
  it("sends via the transporter with the configured from address", async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const provider = new SmtpEmailProvider({ sendMail } as never);

    await provider.send({ to: "user@example.com", subject: "Hi", text: "body" });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Hi",
        text: "body",
      })
    );
  });

  it("propagates transporter errors so the caller can log them", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("smtp down"));
    const provider = new SmtpEmailProvider({ sendMail } as never);

    await expect(
      provider.send({ to: "user@example.com", subject: "Hi", text: "body" })
    ).rejects.toThrow("smtp down");
  });
});
