import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ call: vi.fn(), discard: vi.fn(), rpc: vi.fn(), insert: vi.fn() }));
vi.mock("@/lib/providers/anthropic", () => ({ callStructured: mock.call, recordDiscarded: mock.discard }));
vi.mock("@/lib/log", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ table: (n: string) => n, serviceClient: () => ({
  rpc: mock.rpc, from: () => {
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: { version: 1 }, error: null }), insert: mock.insert };
    return q;
  },
}) }));
import { adaptChannel } from "./adaptation";
import { withExecution } from "./execution";
import type { ArticleVersion, ChannelOutput, ContentRequest } from "@/lib/db/types";
const request = { id: "request", target_audience: "Managers" } as ContentRequest;
const article = { id: "article", title: "Hiring", body_md: "Use structured interviews. [E1]", claim_map: [{ labels: ["E1"] }] } as ArticleVersion;
const previous = { id: "old", article_version_id: "article", channel: "x", subject: null, body: "Old introduction.", hashtags: [] } as unknown as ChannelOutput;
beforeEach(() => { vi.clearAllMocks(); mock.rpc.mockReturnValue({ single: async () => ({ data: { id: "new", status: "draft" }, error: null }) }); });

it("revises only the requested channel using the saved article and saves a fresh unapproved version", async () => {
  mock.call.mockResolvedValue({ value: { body: "Use structured interviews. [E1]\n#Hiring #Teams", hashtags: ["#Hiring", "#Teams"], coreIdea: "Use consistent interviews" }, usage: { inputTokens: 20, outputTokens: 10 } });
  const result = await withExecution(async () => {}, () => adaptChannel(request, article, null, "x", null,
    { id: "job", previous, note: "Only shorten the opening." }), "lease");
  expect(result.formatFailed).toBe(false);
  expect(mock.call).toHaveBeenCalledTimes(1);
  const prompt = mock.call.mock.calls[0]![0].prompt;
  expect(prompt).toContain(article.body_md);
  expect(prompt).toContain(previous.body);
  expect(prompt).toContain("Only shorten the opening.");
  expect(mock.rpc).toHaveBeenCalledWith("save_channel_revision", expect.objectContaining({
    p_job_id: "job", p_lease_id: "lease", p_output: expect.objectContaining({ article_version_id: "article", channel: "x", status: "draft" }),
  }));
  expect(mock.insert).not.toHaveBeenCalled();
});

it("retries unsupported revision figures and never saves them, even with a valid source marker", async () => {
  mock.call.mockResolvedValue({ value: { body: "Hiring improves by 95%. [E1]\n#Hiring #Teams", hashtags: ["#Hiring", "#Teams"], coreIdea: "Hiring" }, usage: { inputTokens: 20, outputTokens: 10 } });
  await expect(adaptChannel(request, article, null, "x", null, { id: "job", previous, note: "Add 95%." })).rejects.toThrow("unsupported figures");
  expect(mock.call).toHaveBeenCalledTimes(2);
  expect(mock.rpc).not.toHaveBeenCalled();
});
