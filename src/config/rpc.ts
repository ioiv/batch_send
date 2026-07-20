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
    robinhood: "https://rpc.mainnet.chain.robinhood.com",
    arbitrum: "https://arb1.arbitrum.io/rpc",
    polygon: "https://polygon-bor-rpc.publicnode.com",
    optimism: "https://mainnet.optimism.io",
    avalanche: "https://api.avax.network/ext/bc/C/rpc",
    hyperliquid: "https://rpc.hyperliquid.xyz/evm",
    monad: "https://rpc.monad.xyz",
    gnosis: "https://rpc.gnosischain.com",
    sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
    hoodi: "https://rpc.hoodi.ethpandaops.io",
    bscTestnet: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    baseSepolia: "https://sepolia.base.org",
    arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
    optimismSepolia: "https://optimism-sepolia-rpc.publicnode.com",
    polygonAmoy: "https://polygon-amoy-bor-rpc.publicnode.com",
    avalancheFuji: "https://api.avax-test.network/ext/bc/C/rpc",
    monadTestnet: "https://testnet-rpc.monad.xyz"
  }
} as const;
