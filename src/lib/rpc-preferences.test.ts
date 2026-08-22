// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { getPreferredRpcEndpoint, rememberRpcEndpoint } from "./rpc-preferences";

describe("RPC preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores RPC endpoints per chain and prefers them over defaults", () => {
    expect(rememberRpcEndpoint("evm", "base", "https://custom.example/rpc")).toBe(true);
    expect(getPreferredRpcEndpoint("evm", "base", "https://default.example"))
      .toBe("https://custom.example/rpc");
    expect(getPreferredRpcEndpoint("evm", "ethereum", "https://eth.example"))
      .toBe("https://eth.example");
  });

  it("does not persist invalid endpoints", () => {
    expect(rememberRpcEndpoint("solana", "mainnet-beta", "not a url")).toBe(false);
    expect(getPreferredRpcEndpoint("solana", "mainnet-beta", "https://default.example"))
      .toBe("https://default.example");
  });
});
