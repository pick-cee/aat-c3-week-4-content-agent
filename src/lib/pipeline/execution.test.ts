import { describe, expect, it } from "vitest";
import { assertExecutionActive, executionLeaseId, withExecution } from "./execution";

describe("worker execution context", () => {
  it("keeps parallel workers' leases isolated", async () => {
    const values = await Promise.all(["first","second"].map(lease=>withExecution(async()=>{},async()=>{
      await new Promise(resolve=>setTimeout(resolve,1));
      await assertExecutionActive();
      return executionLeaseId();
    },lease)));
    expect(values).toEqual(["first","second"]);
    expect(executionLeaseId()).toBeUndefined();
  });
});
