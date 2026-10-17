import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import type { Plugin, ViteDevServer } from "vite";
import { handleNetworkScanRequest } from "./server/network-scan";
import { loadNetworkScanConfig } from "./server/network-scan-config";
import type { SubdomainDiscoveryOptions } from "./server/subdomain-discovery";

const projectRoot = dirname(fileURLToPath(import.meta.url));

function networkScanApi(options: SubdomainDiscoveryOptions): Plugin {
  const configure = (server: Pick<ViteDevServer, "middlewares">) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/api/network-scan") return next();
      void handleNetworkScanRequest(request, response, options).catch(() => {
        if (response.headersSent) { response.destroy(); return; }
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: "扫描服务暂时不可用，请稍后重试。" }));
      });
    });
  };
  return { name: "network-scan-api", configureServer: configure, configurePreviewServer: configure };
}

export default defineConfig(({ mode }) => ({
  // Keep credentials in the middleware closure; never place them in define or client env.
  plugins: [networkScanApi(loadNetworkScanConfig(mode, projectRoot)), react(), tailwindcss()],
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
        evmContractCall: resolve(projectRoot, "evm/call/index.html"),
        evmContractDeploy: resolve(projectRoot, "evm/deploy/index.html"),
        subdomainScan: resolve(projectRoot, "network/subdomains/index.html"),
        websitePathScan: resolve(projectRoot, "network/paths/index.html")
      }
    }
  },
  test: {
    environment: "node",
    // Wallet UI suites load both DOM and crypto SDKs; keep their workers bounded.
    maxWorkers: 2,
    setupFiles: [resolve(projectRoot, "src/test/setup.ts")]
  }
}));
