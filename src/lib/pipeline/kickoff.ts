import "server-only";
import { after } from "next/server";
import { drainPipeline } from "./dispatch";

export function kickoffPipeline(requestId: string): void {
  // Next keeps the invocation alive after sending the response.
  after(async () => {
    try { await drainPipeline(requestId); }
    catch (error) { console.error("[pipeline] background drain failed", error); }
  });
}
