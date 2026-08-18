import { describe, expect, it, vi } from "vitest";
import {
  BlockscoutNftDiscoveryError,
  discoverBlockscoutErc721Candidates,
  MAX_BLOCKSCOUT_NFT_DISCOVERY_RESPONSE_ITEMS,
  resolveBlockscoutDeploymentBlock,
  type BlockscoutNftDiscoveryFetch
} from "./blockscout-nft-discovery";

const baseUrl = "https://robinhoodchain.blockscout.com";
const angelContract = "0xd982d8f175bd50b976f4ad90562c9e38200091f9";
const checksummedAngelContract = "0xD982d8F175BD50B976F4Ad90562c9e38200091f9";
const ownerOne = "0x0000000000000000000000000000000000000011";
const ownerTwo = "0x0000000000000000000000000000000000000022";
const otherOwner = "0x0000000000000000000000000000000000000033";
const creationTransactionHash = "0x26611f18701428846b6681f49090c2319f0d3a4459929f1061f563ecd01051de";

function jsonResponse(body: unknown, status = 200) {
  return {
    json: vi.fn(async () => body),
    ok: status >= 200 && status < 300,
    status
  };
}

function asFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<ReturnType<typeof jsonResponse>>
) {
  return vi.fn(implementation) as unknown as BlockscoutNftDiscoveryFetch & ReturnType<typeof vi.fn>;
}

function serializable(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

describe("discoverBlockscoutErc721Candidates", () => {
  it("reads paginated Robinhood ANGEL instances, deduplicates them, and retains no metadata", async () => {
    const fetchMock = asFetch(async (input, init) => {
      expect(init).toMatchObject({ method: "GET" });
      expect((init?.headers as Record<string, string>).accept).toBe("application/json");
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/api/v2/tokens/${checksummedAngelContract}/instances`);
      expect(url.searchParams.get("holder_address_hash")).toBe(ownerOne);

      if (!url.searchParams.has("unique_token")) {
        return jsonResponse({
          items: [
            {
              id: "1",
              metadata: {
                image: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"
              },
              owner: { hash: ownerOne },
              token: { address_hash: checksummedAngelContract }
            },
            { id: "2", owner: { hash: ownerOne } }
          ],
          next_page_params: { unique_token: "2" }
        });
      }

      expect(url.searchParams.get("unique_token")).toBe("2");
      return jsonResponse({
        items: [
          { id: "2" },
          {
            animation_url: "https://tracker.invalid/private.json",
            id: "7777",
            metadata: { attributes: [{ trait_type: "secret", value: "do-not-retain" }] }
          }
        ],
        next_page_params: null
      });
    });

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: fetchMock,
      ownerAddresses: [ownerOne]
    });

    expect(result.complete).toBe(true);
    expect(result.contractAddress).toBe(checksummedAngelContract);
    expect(result.entriesRead).toBe(4);
    expect(result.pagesRead).toBe(2);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n, 2n, 7777n]);
    expect(result.assets.every((asset) => (
      asset.candidate && asset.discoverySource === "blockscout" && asset.standard === "erc721"
    ))).toBe(true);
    expect(result.owners).toMatchObject([{
      entriesRead: 4,
      issues: [],
      ownerAddress: ownerOne,
      pagesRead: 2,
      status: "complete"
    }]);
    expect(result.owners[0].assets.map((asset) => asset.tokenId)).toEqual([1n, 2n, 7777n]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const serialized = serializable(result);
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("tracker.invalid");
    expect(serialized).not.toContain("do-not-retain");
  });

  it("isolates one owner's request failure, scrubs the issue, and continues with other owners", async () => {
    const privateMaterial = "0x" + "ab".repeat(32);
    const fetchMock = asFetch(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("holder_address_hash") === ownerOne) {
        throw new Error(`request https://secret.invalid/?key=${privateMaterial} failed`);
      }
      return jsonResponse({ items: [{ id: "9" }], next_page_params: null });
    });

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: fetchMock,
      ownerAddresses: [ownerOne, ownerTwo]
    });

    expect(result.complete).toBe(false);
    expect(result.owners.map((owner) => owner.status)).toEqual(["failed", "complete"]);
    expect(result.owners[1].assets.map((asset) => asset.tokenId)).toEqual([9n]);
    expect(result.issues[0]).toMatchObject({
      code: "request-failed",
      ownerAddress: ownerOne,
      safeForDisplay: true
    });
    expect(serializable(result.issues)).not.toContain("secret.invalid");
    expect(serializable(result.issues)).not.toContain(privateMaterial);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid input and unsafe base URLs before making a request", async () => {
    const fetchMock = asFetch(async () => jsonResponse({ items: [] }));

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl: "http://user:password@localhost:4000/api?key=secret",
      contractAddress: "0x1234",
      fetch: fetchMock,
      maxEntries: 0,
      maxPagesPerOwner: 101,
      ownerAddresses: ["not-an-address"]
    });

    expect(result.complete).toBe(false);
    expect(result.assets).toEqual([]);
    expect(result.owners).toEqual([]);
    expect(result.issues.every((issue) => issue.code === "invalid-input")).toBe(true);
    expect(result.issues.every((issue) => issue.safeForDisplay)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(serializable(result)).not.toContain("password");
    expect(serializable(result)).not.toContain("secret");
  });

  it("skips malformed or cross-owner items and rejects a malicious pagination cursor", async () => {
    const tooLargeTokenId = (1n << 256n).toString();
    const fetchMock = asFetch(async () => jsonResponse({
      items: [
        { id: "12" },
        { id: "-1" },
        { id: "01" },
        { id: "0x10" },
        { id: tooLargeTokenId },
        { id: 15 },
        { id: "16", token: { address_hash: "not-an-address" } },
        { id: "17", token: { address_hash: otherOwner } },
        { id: "18", owner: { hash: otherOwner } },
        { id: "19", owner: { hash: "bad-owner" } },
        null
      ],
      next_page_params: { unique_token: "javascript:alert(1)" }
    }));

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: fetchMock,
      ownerAddresses: [ownerOne]
    });

    expect(result.complete).toBe(false);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([12n]);
    expect(result.owners[0].status).toBe("partial");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "invalid-response",
      "invalid-response"
    ]);
    expect(result.issues[0].message).toContain("10 个条目");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(serializable(result)).not.toContain("javascript:");
  });

  it("bounds an oversized response before iterating or retaining any entries", async () => {
    const items = Array.from(
      { length: MAX_BLOCKSCOUT_NFT_DISCOVERY_RESPONSE_ITEMS + 1 },
      (_, index) => ({ id: String(index) })
    );
    const fetchMock = asFetch(async () => jsonResponse({ items, next_page_params: null }));

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: fetchMock,
      ownerAddresses: [ownerOne]
    });

    expect(result.entriesRead).toBe(0);
    expect(result.assets).toEqual([]);
    expect(result.owners[0]).toMatchObject({
      entriesRead: 0,
      pagesRead: 1,
      status: "limit-exceeded"
    });
    expect(result.issues).toEqual([expect.objectContaining({ code: "entry-limit-exceeded" })]);
  });

  it("detects repeated unique_token cursors and deduplicates repeated pages", async () => {
    const fetchMock = asFetch(async () => jsonResponse({
      items: [{ id: "10" }],
      next_page_params: { unique_token: 10 }
    }));

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: fetchMock,
      ownerAddresses: [ownerOne]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([10n]);
    expect(result.entriesRead).toBe(2);
    expect(result.owners[0].status).toBe("partial");
    expect(result.issues).toEqual([expect.objectContaining({ code: "pagination-loop" })]);
  });

  it("passes AbortSignal to fetch and marks current and pending owners aborted", async () => {
    const controller = new AbortController();
    const fetchMock = asFetch(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    const result = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: fetchMock,
      ownerAddresses: [ownerOne, ownerTwo],
      signal: controller.signal
    });

    expect(result.owners.map((owner) => owner.status)).toEqual(["aborted", "aborted"]);
    expect(result.issues.every((issue) => issue.code === "aborted")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on the configured page and entry budgets without silently completing", async () => {
    const pagedFetch = asFetch(async () => jsonResponse({
      items: [{ id: "1" }],
      next_page_params: { unique_token: "1" }
    }));
    const pageLimited = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: pagedFetch,
      maxPagesPerOwner: 1,
      ownerAddresses: [ownerOne]
    });

    expect(pageLimited.owners[0].status).toBe("limit-exceeded");
    expect(pageLimited.issues).toEqual([expect.objectContaining({ code: "page-limit-exceeded" })]);
    expect(pagedFetch).toHaveBeenCalledTimes(1);

    const entryFetch = asFetch(async () => jsonResponse({
      items: [{ id: "1" }, { id: "2" }],
      next_page_params: null
    }));
    const entryLimited = await discoverBlockscoutErc721Candidates({
      baseUrl,
      contractAddress: angelContract,
      fetch: entryFetch,
      maxEntries: 1,
      ownerAddresses: [ownerOne, ownerTwo]
    });

    expect(entryLimited.assets).toEqual([]);
    expect(entryLimited.owners.map((owner) => owner.status)).toEqual([
      "limit-exceeded",
      "limit-exceeded"
    ]);
    expect(entryLimited.issues.every((issue) => issue.code === "entry-limit-exceeded")).toBe(true);
    expect(entryFetch).toHaveBeenCalledTimes(1);
  });
});

describe("resolveBlockscoutDeploymentBlock", () => {
  it("resolves the ANGEL deployment block through address and transaction endpoints", async () => {
    const fetchMock = asFetch(async (input, init) => {
      expect(init).toMatchObject({ method: "GET" });
      const url = new URL(String(input));
      if (url.pathname === `/api/v2/addresses/${checksummedAngelContract}`) {
        return jsonResponse({
          creation_transaction_hash: creationTransactionHash,
          metadata: "must-not-be-returned"
        });
      }
      expect(url.pathname).toBe(`/api/v2/transactions/${creationTransactionHash}`);
      return jsonResponse({ block_number: "35606187", raw_input: "data:text/plain,secret" });
    });

    await expect(resolveBlockscoutDeploymentBlock(
      `${baseUrl}/`,
      angelContract,
      fetchMock
    )).resolves.toBe(35_606_187n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a safe integer block number returned as JSON number", async () => {
    const fetchMock = asFetch(async (input) => {
      const url = new URL(String(input));
      return url.pathname.includes("/addresses/")
        ? jsonResponse({ creation_transaction_hash: creationTransactionHash })
        : jsonResponse({ block_number: 35_606_187 });
    });

    await expect(resolveBlockscoutDeploymentBlock(
      baseUrl,
      angelContract,
      fetchMock
    )).resolves.toBe(35_606_187n);
  });

  it.each([
    [{ creation_transaction_hash: null }, "invalid-response"],
    [{ creation_transaction_hash: "0x1234" }, "invalid-response"]
  ])("strictly rejects malformed creation transaction data", async (body, code) => {
    const fetchMock = asFetch(async () => jsonResponse(body));

    await expect(resolveBlockscoutDeploymentBlock(
      baseUrl,
      angelContract,
      fetchMock
    )).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["01", "-1", "1.5", null, Number.MAX_SAFE_INTEGER + 1])(
    "strictly rejects malformed block_number %s",
    async (blockNumber) => {
      const fetchMock = asFetch(async (input) => {
        const url = new URL(String(input));
        return url.pathname.includes("/addresses/")
          ? jsonResponse({ creation_transaction_hash: creationTransactionHash })
          : jsonResponse({ block_number: blockNumber });
      });

      await expect(resolveBlockscoutDeploymentBlock(
        baseUrl,
        angelContract,
        fetchMock
      )).rejects.toMatchObject({ code: "invalid-response" });
    }
  );

  it("exports a typed, scrubbed error and forwards cancellation", async () => {
    const controller = new AbortController();
    const secret = "0x" + "cd".repeat(32);
    const failedFetch = asFetch(async () => {
      throw new Error(`https://private.invalid/?secret=${secret}`);
    });

    let caught: unknown;
    try {
      await resolveBlockscoutDeploymentBlock(baseUrl, angelContract, failedFetch);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockscoutNftDiscoveryError);
    expect(caught).toMatchObject({ code: "request-failed" });
    expect(String(caught)).not.toContain("private.invalid");
    expect(String(caught)).not.toContain(secret);

    controller.abort();
    const untouchedFetch = asFetch(async () => jsonResponse({}));
    await expect(resolveBlockscoutDeploymentBlock(
      baseUrl,
      angelContract,
      untouchedFetch,
      controller.signal
    )).rejects.toMatchObject({ code: "aborted" });
    expect(untouchedFetch).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS and credentialed Blockscout bases", async () => {
    const fetchMock = asFetch(async () => jsonResponse({}));

    await expect(resolveBlockscoutDeploymentBlock(
      "http://robinhoodchain.blockscout.com",
      angelContract,
      fetchMock
    )).rejects.toMatchObject({ code: "invalid-input" });
    await expect(resolveBlockscoutDeploymentBlock(
      "https://user:password@robinhoodchain.blockscout.com",
      angelContract,
      fetchMock
    )).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
