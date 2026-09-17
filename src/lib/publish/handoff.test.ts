import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ row: {} as Record<string, unknown>, writes: 0, log: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/log", () => ({ logInfo: mock.log }));
vi.mock("@/lib/crypto", () => ({ verifyHandoffToken: () => ({ valid: true, payload: { queueId: "queue" } }) }));
vi.mock("@/lib/db/client", () => ({ table: (name: string) => name, serviceClient: () => ({ from: () => {
  let patch: Record<string, unknown> | undefined, wanted: unknown, excluded: unknown;
  const resolve = () => {
    if (!patch) return { data: { ...mock.row }, error: null };
    if ((wanted && mock.row.status !== wanted) || mock.row.status === excluded) return { data: null, error: null };
    Object.assign(mock.row, patch); mock.writes++;
    return { data: { id: "queue" }, error: null };
  };
  const query: any = { select: () => query, update: (value: Record<string, unknown>) => { patch = value; return query; },
    eq: (key: string, value: unknown) => { if (key === "status") wanted = value; return query; },
    neq: (_key: string, value: unknown) => { excluded = value; return query; },
    maybeSingle: async () => resolve(), then: (fn: (value: unknown) => void) => Promise.resolve(resolve()).then(fn),
  };
  return query;
} }) }));
import { confirmHandoff } from "@/app/actions/handoff";
beforeEach(() => { mock.row = { id: "queue", request_id: "request", status: "awaiting_manual_post", channel: "linkedin", kind: "handoff", platform_url: null }; mock.writes = 0; mock.log.mockReset(); });
describe("handoff confirmation", () => {
  it("records a URL once and preserves it when the same link is opened again", async () => {
    expect(await confirmHandoff("token", "https://www.linkedin.com/posts/first")).toEqual({ ok: true });
    expect(await confirmHandoff("token", "https://www.linkedin.com/posts/second")).toEqual({ ok: true });
    expect(mock.row.platform_url).toBe("https://www.linkedin.com/posts/first");
    expect(mock.writes).toBe(1); expect(mock.log).toHaveBeenCalledTimes(1);
  });
  it("does not resurrect a cancelled handoff", async () => {
    mock.row.status = "cancelled";
    expect((await confirmHandoff("token", "https://www.linkedin.com/posts/first")).ok).toBe(false);
    expect(mock.writes).toBe(0);
  });
  it("does not create duplicate confirmation activity when two submissions race", async () => {
    await Promise.all([confirmHandoff("token", "https://www.linkedin.com/posts/first"), confirmHandoff("token", "https://www.linkedin.com/posts/second")]);
    expect(mock.writes).toBe(1); expect(mock.log).toHaveBeenCalledTimes(1);
  });
});
