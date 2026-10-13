/** 2,000 site paths, 40 script clues, 20 sitemap clues and 44 fixed exposure probes share one bounded document. */
export const MAX_PATH_SOURCE_CANDIDATES = 2200;

const SCRIPT_EXTENSION = /\.(?:cjs|mjs|js|jsx)$/i;
const RESOURCE_EXTENSION = /\.(?:css|less|scss|sass|map|avif|bmp|gif|heic|ico|jpe?g|png|svg|tiff?|webp|eot|otf|ttf|woff2?|aac|avi|flac|m4[av]|mkv|mov|mp[34]|ogg|opus|wav|webm|7z|bz2|exe|gz|rar|tar|zip|pdf|docx?|xlsx?|pptx?|csv|txt|xml|wasm|webmanifest|ts|tsx)$/i;

/** File resources are discovery inputs; JSON endpoints and page extensions remain scan targets. */
export function pathResourceKind(input: string): "script" | "asset" | undefined {
  let path: string;
  try {
    path = new URL(input).pathname;
    try { path = decodeURIComponent(path); } catch { /* Match the original pathname if decoding is unavailable. */ }
  } catch { return undefined; }
  if (SCRIPT_EXTENSION.test(path)) return "script";
  return RESOURCE_EXTENSION.test(path) ? "asset" : undefined;
}
