import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(projectRoot, "src"),
      buffer: resolve(projectRoot, "node_modules/buffer/index.js")
    }
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(projectRoot, "index.html"),
        formatGenerator: resolve(projectRoot, "format/index.html"),
        batchDistributor: resolve(projectRoot, "sol/index.html"),
        solCollection: resolve(projectRoot, "sol/collect/index.html"),
        evmBatchDistributor: resolve(projectRoot, "evm/index.html"),
        evmTokenCollection: resolve(projectRoot, "evm/collect/index.html"),
        evmNftCollection: resolve(projectRoot, "evm/nft-collect/index.html"),
        evmContractDeploy: resolve(projectRoot, "evm/deploy/index.html")
      }
    }
  },
  test: {
    environment: "node",
    setupFiles: [resolve(projectRoot, "src/test/setup.ts")]
  }
});
