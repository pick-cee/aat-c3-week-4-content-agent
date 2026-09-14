import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  /**
   * There are package-lock.json files in parent directories, so Next infers
   * the wrong workspace root and traces files from outside the project.
   * Pinning it here removes the warning and keeps the deployment bundle to
   * this directory.
   */
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  /**
   * `pg` is the migration runner's driver and is Node-only: it reaches for
   * `fs` to read SSL certificates. Left to the bundler it gets traced from
   * instrumentation.ts and fails to resolve `fs`, because instrumentation is
   * compiled for the edge runtime as well as Node.
   *
   * Marking it external leaves the require to Node at runtime, where `fs`
   * exists. The `NEXT_RUNTIME` check inside instrumentation.ts still stops it
   * being *loaded* on the edge — that guard governs execution, this governs
   * bundling, and both are needed.
   */
  serverExternalPackages: ["pg", "pg-connection-string"],

  // Openverse thumbnails and Supabase Storage are the only remote image hosts.
  // A chosen image is downloaded to Storage (DESIGN.md §13) so published
  // content does not depend on a third party's hotlink staying alive; the
  // Openverse hosts are needed only while candidates are being reviewed.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "api.openverse.org" },
      { protocol: "https", hostname: "upload.wikimedia.org" },
      { protocol: "https", hostname: "live.staticflickr.com" },
    ],
  },
};

export default nextConfig;
