export const rpcConfig = {
  solana: {
    mainnetBeta: "https://mainnet.helius-rpc.com/?api-key=4ff5906f-0113-429c-938f-9f65f29ae31c",
    devnet: "https://devnet.helius-rpc.com/?api-key=4ff5906f-0113-429c-938f-9f65f29ae31c",
    testnet: "https://api.testnet.solana.com"
  },
  evm: {
    ethereum: "https://ethereum.publicnode.com",
    bsc: "https://bsc-dataseed.binance.org",
    base: "https://mainnet.base.org",
    arbitrum: "https://arb1.arbitrum.io/rpc",
    polygon: "https://polygon-bor-rpc.publicnode.com",
    optimism: "https://mainnet.optimism.io",
    gnosis: "https://rpc.gnosischain.com",
    fantom: "https://rpcapi.fantom.network",
    moonriver: "https://rpc.api.moonriver.moonbeam.network",
    moonbeam: "https://rpc.api.moonbeam.network",
    sepolia: "https://ethereum-sepolia-rpc.publicnode.com"
  }
} as const;
