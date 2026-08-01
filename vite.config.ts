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
        formatGenerator: resolve(projectRoot, "format/index.html"),
        batchDistributor: resolve(projectRoot, "sol/index.html"),
        evmBatchDistributor: resolve(projectRoot, "evm/index.html"),
        evmContractDeploy: resolve(projectRoot, "evm/deploy/index.html")
      }
    }
  },
  test: {
    environment: "node"
  }
});
