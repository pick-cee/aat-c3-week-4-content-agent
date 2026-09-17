import { beforeEach, describe, expect, it, vi } from "vitest";
const runStep = vi.hoisted(() => vi.fn());
vi.mock("./runner", () => ({ runStep }));
import { drainPipeline } from "./dispatch";
beforeEach(() => vi.clearAllMocks());
describe("background execution", () => {
  it("advances consecutive units immediately until the human gate", async () => {
    runStep.mockResolvedValueOnce({ advanced: true, more: true }).mockResolvedValueOnce({ advanced: true, more: false });
    expect(await drainPipeline("request")).toEqual({ steps: 2 });
    expect(runStep.mock.calls).toEqual([["request"], ["request"]]);
  });
  it("stops when another worker owns the lease", async () => {
    runStep.mockResolvedValue({ advanced: false, more: true });
    expect(await drainPipeline("request")).toEqual({ steps: 0 });
    expect(runStep).toHaveBeenCalledOnce();
  });
  it("leaves delayed retries to durable scheduling", async () => {
    runStep.mockResolvedValue({ advanced: true, more: true, attempt: { current: 1, of: 3 } });
    await drainPipeline("request"); expect(runStep).toHaveBeenCalledOnce();
  });
  it("lets a worker select another request after one reaches review", async () => {
    runStep.mockResolvedValueOnce({ advanced: true, more: false }).mockResolvedValueOnce({ advanced: false });
    expect(await drainPipeline()).toEqual({ steps: 1 });
    expect(runStep.mock.calls).toEqual([[undefined], [undefined]]);
  });
});
