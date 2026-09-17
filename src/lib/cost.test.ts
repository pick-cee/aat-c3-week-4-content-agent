import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), single: vi.fn(), update: vi.fn(), logError: vi.fn() }));
vi.mock("./db/client", () => ({
  table: (name: string) => name,
  serviceClient: () => ({ rpc: mocks.rpc, from: () => ({
    select: () => ({ eq: () => ({ single: mocks.single }) }),
    update: mocks.update,
  }) }),
}));
vi.mock("./log", () => ({ logError: mocks.logError, logWarn: vi.fn() }));
import { assertWithinBudget, BudgetExceededError, priceModelCall, priceEmbedding, recordModelCall, reserveModelCall } from "./cost";
import { withExecution } from "./pipeline/execution";

beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ data: 1.47, error: null }); mocks.single.mockResolvedValue({ data: { actual_cost_cents: 10, reserved_cost_cents: 8, budget_cents: 20, cost_complete: false }, error: null }); });

describe("provider accounting", () => {
  it("prices uncached input, cache creation, and cache reads independently", () => {
    expect(priceModelCall("claude-sonnet-5", { inputTokens:1000,outputTokens:1000,cacheCreationTokens:1000,cacheReadTokens:1000 })).toBeCloseTo(1.47);
  });
  it("never subtracts cache reads from already-uncached input", () => {
    expect(priceModelCall("claude-sonnet-5", { inputTokens:0,outputTokens:0,cacheReadTokens:10000 })).toBeCloseTo(0.2);
  });
  it("preserves sub-cent embedding charges", () => { expect(priceEmbedding(100)).toBeCloseTo(0.0002); });
  it("refuses unpriced models", () => { expect(()=>priceModelCall("unknown",{ inputTokens:1,outputTokens:1 })).toThrow("No price"); });
  it("counts unknown-call reservations against the request limit", async () => { await expect(assertWithinBudget("request",3)).rejects.toBeInstanceOf(BudgetExceededError); });
  it("fails closed if the budget cannot be read", async () => {
    mocks.single.mockResolvedValue({ data:null,error:{message:"database unavailable"} });
    await expect(assertWithinBudget("request",1)).rejects.toThrow("call was not made");
  });
  it("retries an accounting write with the SAME receipt ID", async () => {
    mocks.rpc.mockResolvedValueOnce({data:null,error:{message:"timeout"}}).mockResolvedValueOnce({data:1.47,error:null});
    await recordModelCall({requestId:"request",step:"draft",model:"claude-sonnet-5",usage:{inputTokens:1000,outputTokens:1000},outcome:"used"});
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0]![1].p_call.id).toBe(mocks.rpc.mock.calls[1]![1].p_call.id);
    expect(mocks.rpc.mock.calls[0]![0]).toBe("record_model_call");
  });
  it("persists cache-write tokens on the receipt", async () => {
    await recordModelCall({requestId:"request",step:"draft",model:"claude-sonnet-5",usage:{inputTokens:0,outputTokens:0,cacheCreationTokens:2000},outcome:"used"});
    expect(mocks.rpc.mock.calls[0]![1].p_call.cache_creation_tokens).toBe(2000);
    expect(mocks.rpc.mock.calls[0]![1].p_call.cost_cents).toBeCloseTo(0.5);
  });
  it("sends the current worker lease when reserving a paid operation", async () => {
    mocks.rpc.mockResolvedValue({data:{allowed:true},error:null});
    const active=vi.fn().mockResolvedValue(undefined);
    await withExecution(active,()=>reserveModelCall("call","request","draft","claude-sonnet-5",10),"lease");
    expect(active).toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_model_call",expect.objectContaining({p_lease_id:"lease",p_ceiling:10}));
  });
  it("does not reserve a new operation after cancellation", async () => {
    await expect(withExecution(async()=>{throw new Error("cancelled");},()=>reserveModelCall("call","request","draft","claude-sonnet-5",10),"lease")).rejects.toThrow("cancelled");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("stops on workspace-wide budget exhaustion", async () => {
    mocks.rpc.mockResolvedValue({data:{allowed:false,scope:"workspace"},error:null});
    await expect(reserveModelCall("call","request","draft","claude-sonnet-5",10)).rejects.toThrow("monthly spending limit");
  });
});
