import { describe, expect, it } from "vitest";
import {
  classifyContractCode,
  createXContractAddress,
  createXContractRuntimeCodeHash,
  disperseContractGuardedSalt,
  disperseContractInitCode,
  disperseContractInitCodeHash,
  disperseContractRawSalt,
  getDisperseDeploymentArtifacts,
  getDisperseDeploymentErrorMessage,
  getDisperseDeploymentNetworkForChainId,
  getBufferedDeploymentGasLimit,
  hasDisperseSaltSenderCollision,
  hasExpectedCreateXContractCode
} from "./createx";
import { disperseContractAddress, disperseContractRuntimeCodeHash } from "./evm";

describe("CreateX Disperse deployment artifacts", () => {
  it("reproduces the official guarded salt, bytecode hashes, and CREATE2 address", () => {
    const artifacts = getDisperseDeploymentArtifacts();

    expect(disperseContractRawSalt).toBe("0xfd73487f4e6544007a3ce4000000000000000000000000000000000000000000");
    expect(artifacts.guardedSalt).toBe(disperseContractGuardedSalt);
    expect(artifacts.initCodeHash).toBe(disperseContractInitCodeHash);
    expect(artifacts.runtimeCodeHash).toBe(disperseContractRuntimeCodeHash);
    expect(artifacts.predictedAddress).toBe(disperseContractAddress);
    expect((disperseContractInitCode.length - 2) / 2).toBe(1812);
    expect((artifacts.runtimeCode.length - 2) / 2).toBe(1780);
    expect(artifacts.valid).toBe(true);
  });

  it("detects the single wallet prefix that would select a different CreateX guard branch", () => {
    expect(hasDisperseSaltSenderCollision("0xfd73487f4e6544007a3ce4000000000000000000")).toBe(true);
    expect(hasDisperseSaltSenderCollision("0x629B89efdA867AF176c1aD6d546919FF3EA1F81F")).toBe(false);
  });

  it("adds a rounded-up 20 percent buffer to the deployment gas estimate", () => {
    expect(getBufferedDeploymentGasLimit(500_000n)).toBe(600_000n);
    expect(getBufferedDeploymentGasLimit(1n)).toBe(2n);
  });

  it("classifies absent, expected, and unexpected target bytecode", () => {
    const { runtimeCode } = getDisperseDeploymentArtifacts();

    expect(classifyContractCode(undefined, disperseContractRuntimeCodeHash)).toBe("absent");
    expect(classifyContractCode("0x", disperseContractRuntimeCodeHash)).toBe("absent");
    expect(classifyContractCode(runtimeCode, disperseContractRuntimeCodeHash)).toBe("expected");
    expect(classifyContractCode("0x00", disperseContractRuntimeCodeHash)).toBe("unexpected");
  });

  it("pins the canonical CreateX address and rejects non-official code", () => {
    expect(createXContractAddress).toBe("0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed");
    expect(createXContractRuntimeCodeHash).toBe("0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f");
    expect(hasExpectedCreateXContractCode(undefined)).toBe(false);
    expect(hasExpectedCreateXContractCode("0x")).toBe(false);
    expect(hasExpectedCreateXContractCode("0x00")).toBe(false);
  });
});

describe("Disperse deployment network discovery", () => {
  it("uses known metadata when available and supports unknown EVM chain IDs", () => {
    const arc = getDisperseDeploymentNetworkForChainId(5042, "https://arc.example.test");
    const base = getDisperseDeploymentNetworkForChainId(8453, "https://base.example.test");
    const custom = getDisperseDeploymentNetworkForChainId(7777777, "https://custom.example.test");

    expect(arc).toMatchObject({
      chainId: 5042,
      label: "Arc Mainnet",
      nativeCurrency: { symbol: "USDC" },
      rpcEndpoint: "https://arc.example.test"
    });
    expect(base).toMatchObject({
      chainId: 8453,
      label: "Base",
      rpcEndpoint: "https://base.example.test"
    });
    expect(custom).toEqual({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "EVM Chain 7777777",
      nativeCurrency: { decimals: 18, name: "Native currency", symbol: "NATIVE" },
      rpcEndpoint: "https://custom.example.test"
    });
  });

  it("maps wallet, balance, and RPC authorization failures to actionable messages", () => {
    expect(getDisperseDeploymentErrorMessage({ code: 4001, message: "User rejected" })).toBe("用户取消了部署交易确认");
    expect(getDisperseDeploymentErrorMessage(new Error("insufficient funds"))).toContain("Gas 余额不足");
    expect(getDisperseDeploymentErrorMessage(new Error("401 Unauthorized"))).toContain("RPC 需要授权");
  });
});
