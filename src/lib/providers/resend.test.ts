import { afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ send: vi.fn(), demo: true, redirect: "qa@example.test" }));
vi.mock("resend", () => ({ Resend: class { emails = { send: mock.send }; } }));
vi.mock("@/lib/env", () => ({ env: {
  app: { get demoMode() { return mock.demo; }, get demoRedirectEmail() { return mock.redirect; } },
  resend: { apiKey: "test-only", from: "studio@example.test", replyTo: "" },
} }));
import { sendEmail } from "./resend";
const input = { to: "reader@example.test", subject: "Why your hiring is slowing down", html: "<p>The article.</p>", text: "The article.", idempotencyKey: "qa-one" };
afterEach(() => { vi.clearAllMocks(); mock.demo = true; mock.redirect = "qa@example.test"; });

describe("email presentation and demo routing", () => {
  it("keeps the real subject and body while redirecting and recording demo delivery", async () => {
    mock.send.mockResolvedValue({ data: { id: "provider-one" }, error: null });
    const result = await sendEmail(input);
    expect(mock.send).toHaveBeenCalledWith({ from: "studio@example.test", to: "qa@example.test", subject: input.subject, html: input.html, text: input.text }, { idempotencyKey: "qa-one" });
    expect(result).toMatchObject({ ok: true, isDryRun: true, intendedTo: input.to, messageId: "provider-one" });
  });
  it("refuses a demo send without a redirect address", async () => {
    mock.redirect = "";
    expect(await sendEmail(input)).toMatchObject({ ok: false, isDryRun: true, retryable: false });
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("preserves normal recipient routing outside demo mode", async () => {
    mock.demo = false;
    mock.send.mockResolvedValue({ data: { id: "provider-two" }, error: null });
    expect(await sendEmail(input)).toMatchObject({ ok: true, isDryRun: false });
    expect(mock.send.mock.calls[0]?.[0].to).toBe(input.to);
  });
});
