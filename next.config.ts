import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Both database drivers must be require()d at runtime rather than bundled.
  //
  //   pg      - loads optional native bindings; bundling breaks that lookup.
  //   pglite  - ships a WASM binary and resolves it with a file URL. When the
  //             bundler inlines the module, that URL is handed to fs.readFile
  //             and Node rejects it ("path must be a string, received URL").
  //
  // Keeping both external is what lets the same code run under `next dev`,
  // `next start`, and Vitest without a per-environment special case.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
