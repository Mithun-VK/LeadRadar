import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Standalone output for the container image.
   *
   * Traces the modules actually reachable at runtime and emits a self-contained
   * server, which turns a ~1 GB image with the full node_modules tree into a
   * ~150 MB one. It also means the runtime stage needs no package manager and no
   * install step, so nothing can drift between build and run.
   */
  output: 'standalone',
};

export default nextConfig;
