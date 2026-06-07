export const rpcConfig = {
  solana: {
    mainnetBeta: "https://mainnet.helius-rpc.com/?api-key=10fee8d3-dfcd-4395-981b-e77b67dc4c7d",
    devnet: "https://devnet.helius-rpc.com/?api-key=10fee8d3-dfcd-4395-981b-e77b67dc4c7d",
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
