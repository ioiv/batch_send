import type { EvmCollectionStandard } from "./evm-collection";

export const maximumCollectionSources = 1_000;
export const maximumEvmCollectionAssets = 1_000;
export const maximumEvmCollectionChecks = 5_000;

export function validateEvmCollectionWorkload({
  accountCount,
  assetCount,
  standard
}: {
  accountCount: number;
  assetCount: number;
  standard: EvmCollectionStandard;
}) {
  const issues: string[] = [];
  if (accountCount > maximumCollectionSources) {
    issues.push(`单次最多处理 ${maximumCollectionSources} 个来源钱包，请拆分任务`);
  }
  if (assetCount > maximumEvmCollectionAssets) {
    issues.push(`单次最多处理 ${maximumEvmCollectionAssets} 个资产，请拆分任务`);
  }

  const checkCount = standard === "erc721"
    ? BigInt(assetCount)
    : BigInt(accountCount) * BigInt(assetCount);
  if (checkCount > BigInt(maximumEvmCollectionChecks)) {
    issues.push(`本次将产生 ${checkCount} 次余额检查，超过 ${maximumEvmCollectionChecks} 次安全上限；请减少来源钱包或资产数量`);
  }
  return issues;
}

export function validateSolCollectionWorkload(sourceCount: number) {
  return sourceCount > maximumCollectionSources
    ? [`单次最多处理 ${maximumCollectionSources} 个来源钱包，请拆分任务`]
    : [];
}

export function validateSolTokenCollectionWorkload(sourceCount: number, mintCount: number) {
  const issues = validateSolCollectionWorkload(sourceCount);
  if (mintCount > maximumEvmCollectionAssets) {
    issues.push(`单次最多处理 ${maximumEvmCollectionAssets} 个 Token Mint，请拆分任务`);
  }
  const checkCount = BigInt(sourceCount) * BigInt(mintCount);
  if (checkCount > BigInt(maximumEvmCollectionChecks)) {
    issues.push(
      `本次将产生 ${checkCount} 组钱包与 Token 检查，超过 ${maximumEvmCollectionChecks} 次安全上限；请减少来源钱包或 Token 数量`
    );
  }
  return issues;
}
