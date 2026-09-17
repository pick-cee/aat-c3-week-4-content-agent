import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reserve: vi.fn(), record: vi.fn(), fetch: vi.fn(), checkpoint: null as unknown }));
vi.mock("@/lib/env", () => ({ env: { firecrawl: { apiKey: "test-key" } } }));
vi.mock("@/lib/cost", () => ({ priceScrapes: (n: number) => n * 0.1, reserveModelCall: mocks.reserve, recordModelCall: mocks.record }));
vi.mock("@/lib/db/client", () => ({ table: (name: string) => name, serviceClient: () => ({ from: () => {
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "not", "order", "limit"]) query[name] = () => query;
  query.maybeSingle = async () => ({ data: mocks.checkpoint ? { response_json: mocks.checkpoint } : null, error: null });
  return query;
} }) }));
import { scrape } from "./firecrawl";

beforeEach(() => { vi.clearAllMocks(); mocks.checkpoint = null; vi.stubGlobal("fetch", mocks.fetch); });
describe("paid scrape recovery", () => {
  it("uses a completed checkpoint without reserving or buying another read", async () => {
    mocks.checkpoint = { status: "ok", markdown: "Saved page" };
    expect(await scrape("https://example.com", "request")).toEqual(mocks.checkpoint);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("reserves before fetching and records cache hits as paid", async () => {
    mocks.fetch.mockImplementation(async () => {
      expect(mocks.reserve).toHaveBeenCalledOnce();
      return Response.json({ success: true, data: { markdown: "Article text. ".repeat(100), metadata: { cached: true, contentType: "text/html" } } });
    });
    await scrape("https://example.com", "request");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ costCentsOverride: 0.1, usageKnown: true, response: expect.objectContaining({ status: "ok" }) }));
  });
  it("keeps an unknown allowance after a lost response, with no hidden retry", async () => {
    mocks.fetch.mockRejectedValue(new Error("network interrupted"));
    await expect(scrape("https://example.com", "request")).rejects.toThrow("network interrupted");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usageKnown: false, costCeilingCents: expect.closeTo(0.6) }));
  });
  it("does not pretend a PDF with missing usage cost one HTML credit", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ success: true, data: { markdown: "Evidence. ".repeat(100) } }));
    await scrape("https://example.com/report.pdf", "request");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usageKnown: false, costCentsOverride: 0 }));
  });
  it("records an HTTP refusal without an unknown charge", async () => {
    mocks.fetch.mockResolvedValue(new Response("", { status: 401 }));
    await expect(scrape("https://example.com", "request")).rejects.toThrow("401");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usageKnown: true, costCeilingCents: 0 }));
  });
});
