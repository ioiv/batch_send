import {
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient
} from "viem";

const erc165InterfaceId = "0x01ffc9a7" as const;
const invalidInterfaceId = "0xffffffff" as const;
const erc721InterfaceId = "0x80ac58cd" as const;
const erc721EnumerableInterfaceId = "0x780e9d63" as const;
const erc1155InterfaceId = "0xd9b67a26" as const;

const inspectionAbi = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function name() view returns (string)",
  "function symbol() view returns (string)"
]);

const secretPattern = /0x[0-9a-fA-F]{64}/g;
const urlPattern = /https?:\/\/\S+/gi;

export type NftContractInspection = {
  address: Address;
  enumerable: boolean;
  issues: string[];
  name: string;
  snapshotBlock: bigint;
  standard: "erc721" | "erc1155" | "unknown";
  symbol: string;
};

export type NftContractInspectionClient = Pick<PublicClient, "getBlockNumber" | "readContract">;

function safeMessage(error: unknown, fallback: string) {
  const candidate = error && typeof error === "object"
    ? error as { message?: unknown; shortMessage?: unknown }
    : null;
  const raw = typeof candidate?.shortMessage === "string"
    ? candidate.shortMessage
    : typeof candidate?.message === "string"
      ? candidate.message
      : fallback;
  return raw
    .replace(secretPattern, "[已隐藏敏感内容]")
    .replace(urlPattern, "[RPC 地址已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || fallback;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
}

export async function inspectNftContract({
  contractAddress,
  publicClient
}: {
  contractAddress: string;
  publicClient: NftContractInspectionClient;
}): Promise<NftContractInspection> {
  if (!isAddress(contractAddress) || getAddress(contractAddress) === zeroAddress) {
    throw new Error("NFT 合约地址格式不正确");
  }
  const address = getAddress(contractAddress);
  const snapshotBlock = await publicClient.getBlockNumber();
  const readInterface = (interfaceId: typeof erc165InterfaceId | typeof invalidInterfaceId
    | typeof erc721InterfaceId | typeof erc721EnumerableInterfaceId | typeof erc1155InterfaceId) => (
    publicClient.readContract({
      abi: inspectionAbi,
      address,
      args: [interfaceId],
      blockNumber: snapshotBlock,
      functionName: "supportsInterface"
    })
  );

  let supportsErc165: unknown;
  let rejectsInvalid: unknown;
  let supportsErc721: unknown;
  let supportsEnumerable: unknown;
  let supportsErc1155: unknown;
  try {
    [supportsErc165, rejectsInvalid, supportsErc721, supportsEnumerable, supportsErc1155] = await Promise.all([
      readInterface(erc165InterfaceId),
      readInterface(invalidInterfaceId),
      readInterface(erc721InterfaceId),
      readInterface(erc721EnumerableInterfaceId),
      readInterface(erc1155InterfaceId)
    ]);
  } catch (error) {
    throw new Error(safeMessage(error, "无法读取 NFT 合约接口"));
  }

  if ([supportsErc165, rejectsInvalid, supportsErc721, supportsEnumerable, supportsErc1155]
    .some((value) => typeof value !== "boolean")) {
    throw new Error("NFT 合约接口检测返回格式不正确");
  }

  const issues: string[] = [];
  const erc165Valid = supportsErc165 === true && rejectsInvalid === false;
  let standard: NftContractInspection["standard"] = "unknown";
  if (!erc165Valid) {
    issues.push("合约未通过 ERC165 规范校验");
  } else if (supportsErc721 === true && supportsErc1155 === true) {
    issues.push("合约同时声明 ERC721 与 ERC1155，需手动确认标准");
  } else if (supportsErc721 === true) {
    standard = "erc721";
  } else if (supportsErc1155 === true) {
    standard = "erc1155";
  } else {
    issues.push("合约未声明 ERC721 或 ERC1155 接口");
  }

  const [nameResult, symbolResult] = await Promise.allSettled([
    publicClient.readContract({ abi: inspectionAbi, address, blockNumber: snapshotBlock, functionName: "name" }),
    publicClient.readContract({ abi: inspectionAbi, address, blockNumber: snapshotBlock, functionName: "symbol" })
  ]);

  return {
    address,
    enumerable: standard === "erc721" && supportsEnumerable === true,
    issues,
    name: nameResult.status === "fulfilled" ? cleanText(nameResult.value) : "",
    snapshotBlock,
    standard,
    symbol: symbolResult.status === "fulfilled" ? cleanText(symbolResult.value) : ""
  };
}
