const rpcPreferenceStorageKey = "batch-send.rpc-preferences.v1";

type StoredRpcPreferences = Record<string, string>;

function readPreferences(): StoredRpcPreferences {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(rpcPreferenceStorageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && isRpcEndpoint(entry[1])
    )));
  } catch {
    return {};
  }
}

export function isRpcEndpoint(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function getPreferredRpcEndpoint(scope: "evm" | "solana", networkId: string, fallback: string) {
  return readPreferences()[`${scope}:${networkId}`] || fallback;
}

export function rememberRpcEndpoint(scope: "evm" | "solana", networkId: string, rpcEndpoint: string) {
  const normalized = rpcEndpoint.trim();
  if (typeof window === "undefined" || !isRpcEndpoint(normalized)) return false;
  try {
    const preferences = readPreferences();
    preferences[`${scope}:${networkId}`] = normalized;
    window.localStorage.setItem(rpcPreferenceStorageKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
