export type ToolCategory = "distribution" | "collection" | "contract";

export type ToolEcosystem = "evm" | "solana";

export type ToolIcon = "send" | "collect" | "nft" | "sol" | "contract";

export interface ToolDefinition {
  id: string;
  title: string;
  shortTitle: string;
  description: string;
  href: string;
  category: ToolCategory;
  ecosystems: ToolEcosystem[];
  icon: ToolIcon;
  featured?: boolean;
  badge?: "热门" | "新增";
  keywords: string[];
}

export interface ToolCategoryDefinition {
  id: ToolCategory;
  label: string;
  description: string;
  href: string;
}

export interface EcosystemDefinition {
  id: ToolEcosystem;
  label: string;
}

export const toolCategories: ToolCategoryDefinition[] = [
  {
    id: "distribution",
    label: "批量发送",
    description: "从一个钱包向多个地址分发资产",
    href: "/#distribution"
  },
  {
    id: "collection",
    label: "资产归集",
    description: "将多个钱包中的资产收拢到目标地址",
    href: "/#collection"
  },
  {
    id: "contract",
    label: "合约工具",
    description: "部署、校验并管理 EVM 合约",
    href: "/#contract"
  }
];

export const supportedEcosystems: EcosystemDefinition[] = [
  { id: "evm", label: "EVM" },
  { id: "solana", label: "Solana" }
];

export const tools: ToolDefinition[] = [
  {
    id: "evm-token-collection",
    title: "EVM 代币归集",
    shortTitle: "代币归集",
    description: "归集多个 EVM 钱包的原生币或 ERC20 余额，交易前完成余额与费用预检。",
    href: "/evm/collect/",
    category: "collection",
    ecosystems: ["evm"],
    icon: "collect",
    featured: true,
    badge: "新增",
    keywords: ["原生币", "ERC20", "Token", "归集", "EVM"]
  },
  {
    id: "evm-nft-collection",
    title: "EVM NFT 归集",
    shortTitle: "NFT 归集",
    description: "按来源钱包归集 ERC721 与 ERC1155 资产，交易前完成所有权校验。",
    href: "/evm/nft-collect/",
    category: "collection",
    ecosystems: ["evm"],
    icon: "nft",
    featured: true,
    badge: "新增",
    keywords: ["NFT", "ERC721", "ERC1155", "归集"]
  },
  {
    id: "sol-collection",
    title: "SOL 归集",
    shortTitle: "SOL 归集",
    description: "批量读取 SOL 余额，预留网络费与保留金额后归集到指定钱包。",
    href: "/sol/collect/",
    category: "collection",
    ecosystems: ["solana"],
    icon: "sol",
    featured: true,
    badge: "新增",
    keywords: ["SOL", "Solana", "余额", "归集"]
  },
  {
    id: "sol-distribution",
    title: "SOL 批量分发",
    shortTitle: "SOL 分发",
    description: "校验收款清单并通过连接的钱包批量发送 SOL。",
    href: "/sol/",
    category: "distribution",
    ecosystems: ["solana"],
    icon: "send",
    featured: true,
    badge: "热门",
    keywords: ["SOL", "Solana", "批量发送", "空投"]
  },
  {
    id: "evm-distribution",
    title: "EVM 批量分发",
    shortTitle: "EVM 分发",
    description: "向地址清单批量发送原生币或 ERC20 代币。",
    href: "/evm/",
    category: "distribution",
    ecosystems: ["evm"],
    icon: "send",
    featured: true,
    badge: "热门",
    keywords: ["EVM", "ERC20", "批量发送", "空投"]
  },
  {
    id: "evm-contract-deploy",
    title: "CreateX 合约部署",
    shortTitle: "合约部署",
    description: "生成并校验确定性部署参数，再由钱包提交部署交易。",
    href: "/evm/deploy/",
    category: "contract",
    ecosystems: ["evm"],
    icon: "contract",
    keywords: ["CreateX", "CREATE2", "合约", "部署"]
  }
];

export const featuredTools = tools.filter((tool) => tool.featured);

export function getToolById(toolId?: string) {
  return tools.find((tool) => tool.id === toolId);
}

export function getToolsByCategory(category: ToolCategory) {
  return tools.filter((tool) => tool.category === category);
}

export function getToolsByEcosystem(ecosystem: ToolEcosystem) {
  return tools.filter((tool) => tool.ecosystems.includes(ecosystem));
}
