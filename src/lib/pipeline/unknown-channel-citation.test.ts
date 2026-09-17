import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ call: vi.fn(), discard: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/providers/anthropic", () => ({ callStructured: mock.call, recordDiscarded: mock.discard }));
vi.mock("@/lib/db/client", () => ({ table: (name: string) => name, serviceClient: () => ({ from: mock.write }) }));
vi.mock("@/lib/log", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
import { adaptChannel } from "./adaptation";
import type { ArticleVersion, ContentRequest } from "@/lib/db/types";
it("discards an E99 hallucination, retries once, and never saves it as a channel warning", async () => {
  mock.call.mockResolvedValue({ value: { body: "A fabricated claim. [E99]" }, usage: { inputTokens: 100, outputTokens: 10 }, callId: "test-call" });
  const request = { id: "request", idea: "Hiring", target_audience: "Founders" } as ContentRequest;
  const version = { id: "version", title: "Hiring", body_md: "Supported fact. [E1]", claim_map: [{ labels: ["E1"] }] } as ArticleVersion;
  await expect(adaptChannel(request, version, null, "newsletter", null)).rejects.toThrow("repeatedly cited sources absent");
  expect(mock.call).toHaveBeenCalledTimes(2);
  expect(mock.discard).toHaveBeenCalledTimes(2);
  expect(mock.write).not.toHaveBeenCalled();
});
