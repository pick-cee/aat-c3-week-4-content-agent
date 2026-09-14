/**
 * Lets `npm run broken-pack` import the server modules under tsx.
 *
 * `server-only` throws on import outside a React Server Component, which is
 * the guard that keeps keys out of the browser (DESIGN.md §19.1). It is worth
 * keeping in the app and has to be stubbed for a standalone script, exactly as
 * vitest.config.ts does for tests.
 */
const Module = require("node:module");
const resolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...args) {
  if (request === "server-only") {
    return require.resolve("./server-only-noop.cjs");
  }
  return resolve.call(this, request, ...args);
};
