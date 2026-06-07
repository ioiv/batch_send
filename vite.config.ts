import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      buffer: "buffer"
    }
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(projectRoot, "index.html"),
        formatGenerator: resolve(projectRoot, "format-generator.html"),
        batchDistributor: resolve(projectRoot, "batch-distributor.html"),
        evmBatchDistributor: resolve(projectRoot, "evm-batch-distributor.html")
      }
    }
  },
  test: {
    environment: "node"
  }
});
