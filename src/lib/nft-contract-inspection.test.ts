import { describe, expect, it, vi } from "vitest";
import { createNftContractMetadataReader, inspectNftContract, readNftContractMetadata, type NftContractInspectionClient } from "./nft-contract-inspection";

const contract = "0xD982d8F175BD50B976F4Ad90562c9e38200091f9";

function createClient({
  enumerable = false,
  erc1155 = false,
  erc721 = true
}: {
  enumerable?: boolean;
  erc1155?: boolean;
  erc721?: boolean;
} = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(38_000_000n),
    readContract: vi.fn(async (request: { args?: readonly string[]; functionName: string }) => {
      if (request.functionName === "name") return "Inference Angels";
      if (request.functionName === "symbol") return "ANGEL";
      const interfaceId = request.args?.[0];
      if (interfaceId === "0x01ffc9a7") return true;
      if (interfaceId === "0xffffffff") return false;
      if (interfaceId === "0x80ac58cd") return erc721;
      if (interfaceId === "0x780e9d63") return enumerable;
      if (interfaceId === "0xd9b67a26") return erc1155;
      throw new Error("unexpected call");
    })
  } as unknown as NftContractInspectionClient & {
    getBlockNumber: ReturnType<typeof vi.fn>;
    readContract: ReturnType<typeof vi.fn>;
  };
}

describe("inspectNftContract", () => {
  it("recognizes the Robinhood ANGEL contract as non-enumerable ERC721", async () => {
    const result = await inspectNftContract({ contractAddress: contract, publicClient: createClient() });

    expect(result).toMatchObject({
      enumerable: false,
      name: "Inference Angels",
      standard: "erc721",
      symbol: "ANGEL"
    });
    expect(result.snapshotBlock).toBe(38_000_000n);
    expect(result.issues).toEqual([]);
  });

  it("recognizes ERC1155 while treating name and symbol as optional", async () => {
    const client = createClient({ erc721: false, erc1155: true });
    client.readContract.mockImplementation(async (request: { args?: readonly string[]; functionName: string }) => {
      if (request.functionName === "name" || request.functionName === "symbol") throw new Error("not implemented");
      const interfaceId = request.args?.[0];
      if (interfaceId === "0x01ffc9a7") return true;
      if (interfaceId === "0xffffffff") return false;
      if (interfaceId === "0x80ac58cd" || interfaceId === "0x780e9d63") return false;
      if (interfaceId === "0xd9b67a26") return true;
      throw new Error("unexpected call");
    });

    const result = await inspectNftContract({ contractAddress: contract, publicClient: client });
    expect(result).toMatchObject({ enumerable: false, name: "", standard: "erc1155", symbol: "" });
  });

  it("uses the same cleaned display metadata for inspection and cached scan reads", async () => {
    const client = createClient();
    client.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: readonly string[] }) => {
      if (functionName === "name") return "  Example\u0000 Collectibles  ";
      if (functionName === "symbol") return "  EXNFT  ";
      return args?.[0] === "0x01ffc9a7" || args?.[0] === "0x80ac58cd";
    });
    const inspection = await inspectNftContract({ contractAddress: contract, publicClient: client });
    const readMetadata = createNftContractMetadataReader(client);
    const [first, second] = await Promise.all([readMetadata(contract), readMetadata(contract.toLowerCase() as typeof contract)]);

    expect(first).toMatchObject({ name: inspection.name, symbol: inspection.symbol, decimals: 0 });
    expect(first).toBe(second);
    const nameRequests = client.readContract.mock.calls.map(([request]) => request).filter(request => request.functionName === "name");
    expect(nameRequests).toHaveLength(2);
    expect(nameRequests[0].blockNumber).toBe(38_000_000n);
    expect(nameRequests[1].blockNumber).toBeUndefined();
  });

  it("retains an available name when the optional symbol is absent", async () => {
    const client = createClient();
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "name") return "Example Collectibles";
      throw new Error("symbol not implemented");
    });
    expect(await readNftContractMetadata({ contractAddress: contract, publicClient: client })).toMatchObject({
      name: "Example Collectibles", symbol: ""
    });
  });

  it("keeps scan caches scoped to their client instead of mixing networks", async () => {
    const firstClient = createClient();
    const secondClient = createClient();
    secondClient.readContract.mockResolvedValue("Different Network");
    const first = await createNftContractMetadataReader(firstClient)(contract);
    const second = await createNftContractMetadataReader(secondClient)(contract);
    expect(first.name).toBe("Inference Angels");
    expect(second.name).toBe("Different Network");
  });

  it("rejects an ambiguous contract instead of guessing a transfer standard", async () => {
    const result = await inspectNftContract({
      contractAddress: contract,
      publicClient: createClient({ erc721: true, erc1155: true })
    });

    expect(result.standard).toBe("unknown");
    expect(result.issues[0]).toContain("同时声明");
  });

  it("rejects zero and malformed addresses before making RPC calls", async () => {
    const client = createClient();
    await expect(inspectNftContract({
      contractAddress: "0x0000000000000000000000000000000000000000",
      publicClient: client
    })).rejects.toThrow("格式不正确");
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });
});
