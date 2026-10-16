export type ToolCategory = "distribution" | "collection" | "contract" | "network";

export type ToolEcosystem = "evm" | "solana" | "web";

export type ToolIcon = "send" | "collect" | "nft" | "sol" | "contract" | "domain" | "path";

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
    description: "批量调用、部署并校验 EVM 合约",
    href: "/#contract"
  },
  {
    id: "network",
    label: "网络工具",
    description: "扫描域名解析与网站路径响应",
    href: "/#network"
  }
];

export const supportedEcosystems: EcosystemDefinition[] = [
  { id: "evm", label: "EVM" },
  { id: "solana", label: "Solana" },
  { id: "web", label: "网络" }
];

export const tools: ToolDefinition[] = [
  {
    id: "evm-token-collection",
    title: "EVM 代币归集",
    shortTitle: "代币归集",
    description: "支持手动清单与一键扫描归集，按 Token、NFT、可选原生币顺序执行。",
    href: "/evm/collect/",
    category: "collection",
    ecosystems: ["evm"],
    icon: "collect",
    featured: true,
    badge: "新增",
    keywords: ["原生币", "ERC20", "Token", "NFT", "一键归集", "扫描", "归集", "EVM"]
  },
  {
    id: "evm-nft-collection",
    title: "EVM NFT 归集",
    shortTitle: "NFT 归集",
    description: "手动归集 ERC721 / ERC1155，或一键扫描钱包资产并按阶段归集。",
    href: "/evm/nft-collect/",
    category: "collection",
    ecosystems: ["evm"],
    icon: "nft",
    featured: true,
    badge: "新增",
    keywords: ["NFT", "ERC721", "ERC1155", "一键归集", "扫描", "归集"]
  },
  {
    id: "sol-collection",
    title: "SOL / SPL Token 归集",
    shortTitle: "SOL / SPL 归集",
    description: "支持手动清单与全量 SPL / Token-2022 扫描，先归集资产，再可选归集 SOL。",
    href: "/sol/collect/",
    category: "collection",
    ecosystems: ["solana"],
    icon: "sol",
    featured: true,
    badge: "新增",
    keywords: ["SOL", "Solana", "SPL Token", "Token-2022", "NFT", "ATA", "持仓", "余额", "一键归集", "扫描", "归集"]
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
    id: "evm-contract-call",
    title: "EVM 合约批量调用",
    shortTitle: "合约批量调用",
    description: "按钱包替换 calldata 模板，本地签名后通过自定义 RPC 并发提交。",
    href: "/evm/call/",
    category: "contract",
    ecosystems: ["evm"],
    icon: "contract",
    featured: true,
    badge: "新增",
    keywords: ["EVM", "合约批量调用", "合约", "calldata", "私钥", "本地签名", "RPC", "批量交互"]
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
  },
  {
    id: "subdomain-scan",
    title: "子域名扫描",
    shortTitle: "子域名扫描",
    description: "汇总证书记录、被动 DNS、网站链接与历史网页，去重验证子域名并标记发现来源。",
    href: "/network/subdomains/",
    category: "network",
    ecosystems: ["web"],
    icon: "domain",
    badge: "新增",
    keywords: ["子域名", "域名", "DNS", "subdomain", "扫描", "网络", "证书", "CT", "OSINT", "被动发现"]
  },
  {
    id: "website-path-scan",
    title: "网站路径扫描",
    shortTitle: "网站路径扫描",
    description: "从网页、脚本、站点地图与历史记录自动发现路径，验证响应并导出结果。",
    href: "/network/paths/",
    category: "network",
    ecosystems: ["web"],
    icon: "path",
    badge: "新增",
    keywords: ["网站", "路径", "目录", "HTTP", "path", "扫描", "网络", "状态码", "爬取", "脚本", "sitemap", "robots", "Wayback", "自动发现"]
  }
];

export const featuredTools = tools.filter((tool) => tool.featured);

export function getToolEcosystemLabel(tool: ToolDefinition) {
  return tool.ecosystems.map(ecosystem => ecosystem === "evm" ? "EVM" : ecosystem === "solana" ? "SOL" : "网络").join(" · ");
}

export function getToolById(toolId?: string) {
  return tools.find((tool) => tool.id === toolId);
}

export function getToolsByCategory(category: ToolCategory) {
  return tools.filter((tool) => tool.category === category);
}

export function getToolsByEcosystem(ecosystem: ToolEcosystem) {
  return tools.filter((tool) => tool.ecosystems.includes(ecosystem));
}
