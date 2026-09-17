import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ existing: vi.fn(), insert: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ table: (name: string) => name, serviceClient: () => ({ from: () => ({
  select: () => ({ eq: mocks.existing }), insert: (rows: unknown) => ({ select: () => mocks.insert(rows) }),
}) }) }));
vi.mock("@/lib/log", () => ({ logWarn: mocks.log }));
import { findImageCandidates } from "./images";
import type { ArticleVersion, ContentRequest } from "@/lib/db/types";

const request = { id: "request" } as ContentRequest;
const version = { title: "Hiring takes too long", primary_keyword: "time-to-hire" } as ArticleVersion;
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("automatic licensed image discovery", () => {
  it("reuses saved candidates without calling the image provider", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mocks.existing.mockResolvedValue({ data: [{ id: "saved" }], error: null });
    expect(await findImageCandidates(request, version)).toEqual([{ id: "saved" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tries a simpler query after empty results and stores only usable licences", async () => {
    mocks.existing.mockResolvedValue({ data: [], error: null });
    mocks.insert.mockImplementation(async rows => ({ data: rows, error: null }));
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { id: "photo", license: "by", url: "https://images.example/photo.jpg" },
        { id: "restricted", license: "by-nc", url: "https://images.example/restricted.jpg" },
        { id: "unknown", url: "https://images.example/unknown.jpg" },
      ] }) });
    vi.stubGlobal("fetch", fetch);
    const result = await findImageCandidates(request, version);
    expect(result).toHaveLength(1);
    expect(result[0]?.query_used).toBe("office meeting");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1].signal).toBe(fetch.mock.calls[1]?.[1].signal);
  });

  it("does not fail the article even if image search and warning storage are unavailable", async () => {
    mocks.existing.mockResolvedValue({ data: [], error: null });
    mocks.log.mockRejectedValue(new Error("database unavailable"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(findImageCandidates(request, version)).resolves.toEqual([]);
  });
});
