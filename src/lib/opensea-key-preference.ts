export const openSeaApiKeyStorageKey = "chainkit.opensea-api-key.v1";

export function getStoredOpenSeaApiKey() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(openSeaApiKeyStorageKey) || "";
  } catch {
    return "";
  }
}

export function rememberOpenSeaApiKey(apiKey: string) {
  if (typeof window === "undefined") return false;
  try {
    if (apiKey) window.localStorage.setItem(openSeaApiKeyStorageKey, apiKey);
    else window.localStorage.removeItem(openSeaApiKeyStorageKey);
    return true;
  } catch {
    return false;
  }
}
