// Local configuration lives in .env, shared with the application.
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
process.env.NODE_ENV = "development";
require("dotenv").config({ quiet: true });
const worker = spawn(process.execPath, [require.resolve("tsx/cli"), "--require", resolve("scripts/stub-server-only.cjs"), "scripts/worker.ts", ...process.argv.slice(2)], {
  env: { ...process.env, WORKER_CREATED_AFTER: process.env.WORKER_CREATED_AFTER || new Date().toISOString() },
  stdio: "inherit", windowsHide: true,
});
process.on("SIGINT", () => worker.kill("SIGINT"));
process.on("SIGTERM", () => worker.kill("SIGTERM"));
worker.on("error", error => { console.error(error.message); process.exitCode = 1; });
worker.on("exit", code => { process.exitCode = code ?? 0; });
