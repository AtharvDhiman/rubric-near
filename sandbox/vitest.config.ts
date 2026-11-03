import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each file starts its own local chain, and a few tests wait out real deadlines.
    testTimeout: 180_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
