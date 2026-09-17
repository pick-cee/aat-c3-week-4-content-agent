import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ request: { id: "request", status: "researching", current_step: "discover", runner_lease_id: "lease", step_attempts: 1, deleted_at: null } as Record<string, unknown>, draft: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ randomToken: () => "lease" }));
vi.mock("@/lib/log", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyTerminalFailure: mock.notify }));
vi.mock("./research", () => ({ stepDiscover: async () => ({ seeded: 0, discovered: 0, queries: [], outcome: "no_sources_found" }) }));
vi.mock("./drafting", () => ({ draftArticle: mock.draft }));
vi.mock("@/lib/db/client", () => ({ table: (name: string) => name, serviceClient: () => ({
  rpc: async (name: string) => ({ data: name === "claim_request_lease" ? [{ ...mock.request }] : true, error: null }),
  from: () => {
    let patch: Record<string, unknown> | undefined;
    const resolve = () => { if (patch) Object.assign(mock.request, patch); return { data: { ...mock.request }, error: null }; };
    const query: any = { select: () => query, eq: () => query, neq: () => query, is: () => query,
      update: (value: Record<string, unknown>) => { patch = value; return query; }, single: async () => resolve(), maybeSingle: async () => resolve() };
    return query;
  },
}) }));
import { runStep } from "./runner";
it("stops an actual runner step at needs_human when discovery returns no usable source", async () => {
  const result = await runStep("request");
  expect(result).toMatchObject({ to: "needs_human", more: false });
  expect(mock.request.research_outcome).toBe("no_sources_found");
  expect(mock.draft).not.toHaveBeenCalled();
});
