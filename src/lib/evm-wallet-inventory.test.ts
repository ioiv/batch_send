import { describe, expect, it, vi } from "vitest";
import { createInventoryBudget, discoverEvmWalletInventory, getAutomaticEvmIndexer, normalizeAutomaticIndexer } from "./evm-wallet-inventory";

const wallet = "0x00000000000000000000000000000000000000a1" as const;
const token = "0x00000000000000000000000000000000000000b1";
const nft = "0x00000000000000000000000000000000000000c1";
const indexer = "https://eth.blockscout.com";
const erc20 = (address = token, value = "1") => ({ token: { address_hash: address, type: "ERC-20" }, value });
const erc721 = (id: string, type = "ERC-721") => ({ token: { address_hash: nft, type }, id });
const response = (items: unknown[], next_page_params: unknown = null) => ({ ok: true, status: 200, json: async () => ({ items, next_page_params }) }) as Response;
const scan = (fetcher: typeof fetch, overrides: Partial<Parameters<typeof discoverEvmWalletInventory>[0]> = {}) => discoverEvmWalletInventory({ address: wallet, chainId: 1, indexer, signal: new AbortController().signal, fetcher, ...overrides });

describe("EVM automatic wallet inventory", () => {
  it("follows pagination, deduplicates candidates, excludes zero balances and preserves uint256 NFT IDs", async () => {
    const tokenId = (2n ** 256n - 1n).toString();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([erc20()], { page: 2 }))
      .mockResolvedValueOnce(response([erc20(), erc20("0x00000000000000000000000000000000000000b2", "0")]))
      .mockResolvedValueOnce(response([erc721(tokenId), erc721(tokenId), erc721("9", "ERC-1155")]));
    const result = await scan(fetcher);
    expect(result.complete).toBe(true);
    expect(result.assets).toHaveLength(3);
    expect(result.assets.map(asset => asset.standard)).toEqual(["erc20", "erc721", "erc1155"]);
    expect(result.assets[1]).toMatchObject({ tokenId: 2n ** 256n - 1n });
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("page")).toBe("2");
  });

  it("sends public addresses only and omits browser credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([]));
    await scan(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toContain(`/api/v2/addresses/${wallet}/`);
      expect(options).toMatchObject({ credentials: "omit", headers: { Accept: "application/json" } });
      expect(options?.body).toBeUndefined();
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("preserves discovered assets on rate limits instead of declaring the wallet empty", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([erc20()], { page: 2 }))
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
      .mockResolvedValueOnce(response([erc721("1")]));
    const result = await scan(fetcher);
    expect(result.complete).toBe(false);
    expect(result.assets).toHaveLength(2);
    expect(result.issues.join(" ")).toMatch(/限流/);
  });

  it.each([
    { items: [] },
    { items: [], next_page_params: {} },
    { items: "empty", next_page_params: null }
  ])("marks malformed or ambiguous pagination incomplete: %j", async body => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([erc20()], { page: 2 }))
      .mockResolvedValueOnce({ ok: true, json: async () => body } as Response)
      .mockResolvedValueOnce(response([]));
    const result = await scan(fetcher);
    expect(result.complete).toBe(false);
    expect(result.assets).toHaveLength(1);
    expect(result.issues).not.toHaveLength(0);
  });

  it.each([
    erc20("0x0000000000000000000000000000000000000000"),
    erc20(token, "1e18"),
    erc721("9007199254740993.5"),
    erc721((2n ** 256n).toString()),
    erc721("2", "ERC-404")
  ])("retains prior candidates and rejects malformed asset data: %j", async badItem => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(badItem.token.type === "ERC-20" ? [erc20(), badItem] : [erc20()]))
      .mockResolvedValueOnce(response(badItem.token.type === "ERC-20" ? [erc721("1")] : [erc721("1"), badItem]));
    const result = await scan(fetcher);
    expect(result.complete).toBe(false);
    expect(result.assets.length).toBeGreaterThanOrEqual(1);
    expect(result.issues).not.toHaveLength(0);
  });

  it("stops repeated cursors without losing the completed pages", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([erc20()], { page: 2 }))
      .mockResolvedValueOnce(response([], { page: 2 }))
      .mockResolvedValueOnce(response([]));
    const result = await scan(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.complete).toBe(false);
    expect(result.assets).toHaveLength(1);
    expect(result.issues.join(" ")).toMatch(/分页重复/);
  });

  it("shares request and asset caps across wallets while preserving partial results", async () => {
    const budget = createInventoryBudget();
    budget.requests = 498;
    budget.assets = 4999;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([erc20()]))
      .mockResolvedValueOnce(response([erc721("1")]));
    const first = await scan(fetcher, { budget });
    expect(first.complete).toBe(false);
    expect(first.assets).toHaveLength(1);
    expect(first.issues.join(" ")).toMatch(/资产数量.*上限/);
    const second = await scan(fetcher, { budget, address: "0x00000000000000000000000000000000000000a2" });
    expect(second.complete).toBe(false);
    expect(second.issues.join(" ")).toMatch(/请求上限/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds one wallet's asset list without silently dropping the already discovered assets", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(Array.from({ length: 1001 }, (_, index) => erc721(String(index)))));
    const result = await scan(fetcher);
    expect(result.assets).toHaveLength(1000);
    expect(result.complete).toBe(false);
    expect(result.issues.join(" ")).toMatch(/资产数量.*扫描上限/);
  });

  it("rejects a cursor that attempts to override the asset type", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([erc20()], { type: "ERC-1155" }))
      .mockResolvedValueOnce(response([]));
    const result = await scan(fetcher);
    expect(result.complete).toBe(false);
    expect(result.assets).toHaveLength(1);
    expect(result.issues.join(" ")).toMatch(/分页参数无效/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never lets an unverified custom host authorize native sweeping", async () => {
    const result = await scan(vi.fn<typeof fetch>().mockResolvedValue(response([])), { indexer: "https://custom-indexer.example" });
    expect(result.assets).toHaveLength(0);
    expect(result.complete).toBe(false);
    expect(result.issues.join(" ")).toMatch(/无法自动核验.*保留原生币/);
    expect(getAutomaticEvmIndexer(1)).toBe(indexer);
    expect(getAutomaticEvmIndexer(999999)).toBe("");
    expect(normalizeAutomaticIndexer(`${indexer}/api/v2/`)).toBe(indexer);
  });

  it.each(["https://user:secret@eth.blockscout.com", `${indexer}?key=secret`, `${indexer}#secret`, "file:///tmp/inventory"])("rejects a credential-bearing or unsupported endpoint: %s", async endpoint => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(scan(fetcher, { indexer: endpoint })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not fetch after cancellation", async () => {
    const abort = new AbortController(); abort.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(scan(fetcher, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not publish an inventory if cancellation happens while the final JSON response is read", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => {
        abort.abort();
        return { items: [erc721("1")], next_page_params: null };
      } } as Response);
    await expect(scan(fetcher, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
