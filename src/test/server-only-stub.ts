/**
 * Stands in for the `server-only` package under vitest.
 *
 * The real package throws on import outside a React Server Component. That
 * guard is worth keeping in the Next build — it makes "no key reaches the
 * browser" (DESIGN.md §19.1) a compile error rather than a review note — but
 * it also makes the server modules untestable in isolation. Aliased in
 * vitest.config.ts so tests import this empty module instead.
 */
export {};
