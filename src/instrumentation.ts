/**
 * Runs once per server process, before any request is served.
 * Next.js calls `register()` automatically.
 *
 * This file is compiled for the EDGE runtime as well as Node, and the edge
 * build has no `fs`, no `path` and no `pg`. A top-level import of the
 * migration runner therefore breaks the build regardless of any runtime guard
 * inside it, and `serverExternalPackages` does not apply to instrumentation.
 *
 * The import sits inside the `nodejs` branch so only the Node compilation
 * follows it. Next understands this pattern and does not trace the edge build
 * into the branch.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartup } = await import("./lib/db/startup");
    await runStartup();
  }
}
