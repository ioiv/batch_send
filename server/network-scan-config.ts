import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export interface NetworkScanConfig {
  sslmateApiKey?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Private middleware configuration: never use Vite's debug-logging env loader for secrets. */
export function loadNetworkScanConfig(mode: string, envDir: string, environment: Environment = process.env): NetworkScanConfig {
  if (!mode || mode === "local" || /[/\\\u0000\r\n]/u.test(mode)) throw new Error("服务端环境变量模式无效。");
  // An explicitly empty process value also takes precedence, allowing local credentials to be disabled.
  if (environment.SSLMATE_API_KEY !== undefined) return { sslmateApiKey: environment.SSLMATE_API_KEY };

  let sslmateApiKey: string | undefined;
  for (const file of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    try {
      const values = parseEnv(readFileSync(join(envDir, file), "utf8"));
      if (values.SSLMATE_API_KEY !== undefined) sslmateApiKey = values.SSLMATE_API_KEY;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      // Native parser and filesystem errors must not expose file contents or credentials.
      throw new Error("无法读取服务端环境变量文件，请检查文件格式与访问权限。");
    }
  }
  return sslmateApiKey === undefined ? {} : { sslmateApiKey };
}
