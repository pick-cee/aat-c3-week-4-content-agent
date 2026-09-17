import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("demo account access", () => {
  it.each(["true", "false"])("allows enabled demo login with DEMO_MODE=%s", mode => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", mode);
    vi.stubEnv("ENABLE_DEMO_LOGIN", "true");
    expect(env.app.demoLoginEnabled).toBe(true);
    expect(env.app.demoMode).toBe(mode === "true");
  });

  it.each(["true", "false"])("honors disabled demo login with DEMO_MODE=%s", mode => {
    vi.stubEnv("DEMO_MODE", mode);
    vi.stubEnv("ENABLE_DEMO_LOGIN", "false");
    expect(env.app.demoLoginEnabled).toBe(false);
  });

  it.each(["development", "production"])("preserves the default access policy in %s", nodeEnv => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ENABLE_DEMO_LOGIN", undefined);
    expect(env.app.demoLoginEnabled).toBe(nodeEnv === "development");
  });
});
