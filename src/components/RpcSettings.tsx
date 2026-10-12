import type { ReactNode } from "react";
import { AdvancedSettings } from "./WorkbenchPrimitives";

export function RpcSettings({ endpoint, disabled, invalid = false, children }: {
  endpoint: string; disabled?: boolean; invalid?: boolean; children: ReactNode;
}) {
  let host = "未设置";
  try { host = new URL(endpoint).host; } catch { if (endpoint.trim()) host = "地址格式有误"; }
  return <AdvancedSettings label="修改 RPC" summary={`RPC · ${host}`} disabled={disabled} invalid={invalid}>
    {children}
  </AdvancedSettings>;
}
