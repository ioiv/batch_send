import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import type { Plugin, ViteDevServer } from "vite";
import { handleNetworkScanRequest } from "./server/network-scan";

const projectRoot = dirname(fileURLToPath(import.meta.url));

function networkScanApi(): Plugin {
  const configure = (server: Pick<ViteDevServer, "middlewares">) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/api/network-scan") return next();
      void handleNetworkScanRequest(request, response).catch(() => {
        if (response.headersSent) { response.destroy(); return; }
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: "扫描服务暂时不可用，请稍后重试。" }));
      });
    });
  };
  return { name: "network-scan-api", configureServer: configure, configurePreviewServer: configure };
}

export default defineConfig({
  plugins: [networkScanApi(), react(), tailwindcss()],
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
        batchDistributor: resolve(projectRoot, "sol/index.html"),
        solCollection: resolve(projectRoot, "sol/collect/index.html"),
        evmBatchDistributor: resolve(projectRoot, "evm/index.html"),
        evmTokenCollection: resolve(projectRoot, "evm/collect/index.html"),
        evmNftCollection: resolve(projectRoot, "evm/nft-collect/index.html"),
        evmContractDeploy: resolve(projectRoot, "evm/deploy/index.html"),
        subdomainScan: resolve(projectRoot, "network/subdomains/index.html"),
        websitePathScan: resolve(projectRoot, "network/paths/index.html")
      }
    }
  },
  test: {
    environment: "node",
    setupFiles: [resolve(projectRoot, "src/test/setup.ts")]
  }
});
