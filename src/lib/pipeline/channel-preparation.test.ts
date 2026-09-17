import { describe, expect, it, vi } from "vitest";
import { prepareMissingChannels } from "./channel-preparation";

describe("parallel channel preparation", () => {
  it("starts independent channels together and skips already saved outputs", async () => {
    const release: (() => void)[] = [];
    const prepare = vi.fn((_channel: string) => new Promise<void>(resolve => release.push(resolve)));
    const work = prepareMissingChannels(["linkedin", "x", "newsletter"], ["x"], prepare);
    expect(prepare.mock.calls.map(call => call[0])).toEqual(["linkedin", "newsletter"]);
    release.forEach(resolve => resolve());
    await work;
  });
  it("waits for successful sibling saves before returning a failure", async () => {
    let release!: () => void, finished = false;
    const failure = new Error("provider unavailable");
    const work = prepareMissingChannels(["linkedin", "newsletter"], [], channel => channel === "linkedin" ? Promise.reject(failure) : new Promise<void>(resolve => { release = resolve; }));
    const checked = work.catch(error => { expect(error).toBe(failure); finished = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    release(); await checked;
    expect(finished).toBe(true);
  });
});
