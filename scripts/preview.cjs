// Local demo of the production build. Publishing and notification email are
// disabled in these child processes; credentials in .env are not rewritten.
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
require("dotenv").config({ quiet: true });
const previewEnv = { ...process.env, NODE_ENV: "production", DEMO_MODE: "true", ENABLE_DEMO_LOGIN: "true",
  AUTO_MIGRATE: "false", DISABLE_PUBLISHING: "true", RESEND_API_KEY: "", WORKER_CREATED_AFTER: new Date().toISOString(),
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3100" };
const children = [
  spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3100"], { env: previewEnv, stdio: "inherit", windowsHide: true }),
  spawn(process.execPath, [require.resolve("tsx/cli"), "--require", resolve("scripts/stub-server-only.cjs"), "scripts/worker.ts"], { env: previewEnv, stdio: "inherit", windowsHide: true }),
];
let stopping = false;
function stop() { if (stopping) return; stopping = true; children.forEach(child => child.kill("SIGTERM")); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
children.forEach(child => {
  child.on("error", error => { console.error(error.message); process.exitCode = 1; stop(); });
  child.on("exit", code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
});
console.info("Local preview: http://127.0.0.1:3100. Email and publishing paused; worker handles newly created requests.");
