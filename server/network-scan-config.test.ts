import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNetworkScanConfig } from "./network-scan-config";

const directories: string[] = [];

function fixture(files: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "network-scan-config-test-"));
  directories.push(directory);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), value);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("private network scan configuration", () => {
  it("follows Vite's local and mode-specific env file precedence", () => {
    const directory = fixture({
      ".env": "SSLMATE_API_KEY=fake-base-key",
      ".env.local": "SSLMATE_API_KEY=fake-local-key",
      ".env.development": "SSLMATE_API_KEY=fake-development-key",
      ".env.development.local": "SSLMATE_API_KEY=fake-development-local-key"
    });
    expect(loadNetworkScanConfig("development", directory, {})).toEqual({ sslmateApiKey: "fake-development-local-key" });
    rmSync(join(directory, ".env.development.local"));
    expect(loadNetworkScanConfig("development", directory, {})).toEqual({ sslmateApiKey: "fake-development-key" });
    rmSync(join(directory, ".env.development"));
    expect(loadNetworkScanConfig("development", directory, {})).toEqual({ sslmateApiKey: "fake-local-key" });
    rmSync(join(directory, ".env.local"));
    expect(loadNetworkScanConfig("development", directory, {})).toEqual({ sslmateApiKey: "fake-base-key" });
  });

  it("uses the requested preview/production mode without loading development credentials", () => {
    const directory = fixture({
      ".env.development.local": "SSLMATE_API_KEY=fake-development-key",
      ".env.production": "SSLMATE_API_KEY=fake-production-key",
      ".env.production.local": "SSLMATE_API_KEY=fake-production-local-key"
    });
    expect(loadNetworkScanConfig("production", directory, {})).toEqual({ sslmateApiKey: "fake-production-local-key" });
    expect(loadNetworkScanConfig("staging", directory, {})).toEqual({});
  });

  it.each(["fake-process-key", ""])("preserves process environment precedence including %j", sslmateApiKey => {
    const directory = fixture({ ".env.local": "SSLMATE_API_KEY=fake-file-key" });
    expect(loadNetworkScanConfig("development", directory, { SSLMATE_API_KEY: sslmateApiKey })).toEqual({ sslmateApiKey });
    // A lower-priority unreadable file must not block an explicitly supplied process setting.
    mkdirSync(join(directory, ".env"));
    expect(loadNetworkScanConfig("development", directory, { SSLMATE_API_KEY: sslmateApiKey })).toEqual({ sslmateApiKey });
  });

  it("parses quoted keys and comments while returning only the allowed credential", () => {
    const directory = fixture({ ".env.local": [
      "export SSLMATE_API_KEY='fake-quoted-key' # local credential",
      "SSLMATE_OTHER_SECRET=fake-other-secret",
      "DATABASE_PASSWORD=fake-database-password",
      "VITE_PUBLIC_SETTING=public-value"
    ].join("\n") });
    expect(loadNetworkScanConfig("development", directory, {})).toEqual({ sslmateApiKey: "fake-quoted-key" });
  });

  it("retains lower-priority credentials when later files only contain unrelated variables", () => {
    const directory = fixture({ ".env": "SSLMATE_API_KEY=fake-base-key", ".env.development.local": "UNRELATED=true" });
    expect(loadNetworkScanConfig("development", directory, {})).toEqual({ sslmateApiKey: "fake-base-key" });
  });

  it("does not log private values even when debug namespaces are configured", () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const logs = methods.map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    const directory = fixture({ ".env.local": "SSLMATE_API_KEY=fake-private-debug-key\nDEBUG=vite:*" });
    expect(loadNetworkScanConfig("development", directory, { DEBUG: "vite:env,vite:*" }))
      .toEqual({ sslmateApiKey: "fake-private-debug-key" });
    logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });

  it("returns no credential when env files and process settings are absent", () => {
    expect(loadNetworkScanConfig("development", fixture(), {})).toEqual({});
  });

  it("replaces native file failures with a fixed safe message", () => {
    const directory = fixture();
    mkdirSync(join(directory, ".env.local"));
    expect(() => loadNetworkScanConfig("development", directory, {}))
      .toThrow("无法读取服务端环境变量文件，请检查文件格式与访问权限。");
  });

  it.each(["local", "../fake-private-mode", "production\nFAKE_SECRET", ""])("rejects invalid modes without including their contents in errors", mode => {
    expect(() => loadNetworkScanConfig(mode, fixture(), {})).toThrow("服务端环境变量模式无效。");
  });
});
