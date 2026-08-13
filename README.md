# ChainKit 链上工具箱

ChainKit 是一个基于 React、TypeScript 和 Vite 的多链工具站。目前包含 SOL / EVM 批量发送、CreateX 部署、格式生成，以及本次新增的 ERC20、EVM NFT 与 SOL 归集工作台。

## 本地开发

```bash
npm install
npm run dev
```

质量检查：

```bash
npm test
npm run build
```

## 新增归集路由

| 功能 | 路由 | 输入格式 |
| --- | --- | --- |
| ERC20 代币归集 | `/evm/collect/` | 资产每行一个合约地址；密钥每行 `0x私钥` 或 `标签,0x私钥` |
| EVM NFT 归集 | `/evm/nft-collect/` | 资产每行 `合约地址,Token ID`，可选 ERC721 / ERC1155 |
| SOL 归集 | `/sol/collect/` | 每行 Base58、JSON 数组密钥，或 `标签,密钥` |

三类归集都使用“解析 / 扫描 → 无密钥预览 → 明确确认 → 本地签名 → 逐项提交与确认”的流程。失败不会中断整批任务，提交后确认异常会保留交易哈希，并提示先核对链上状态，避免盲目重发。

## 扩展新工具

工具入口统一登记在 `src/config/tools.ts`。新增功能时：

1. 在注册表增加工具元数据、分类和链支持；
2. 新增页面、entry 与对应 HTML 路由；
3. 在 `vite.config.ts` 登记入口；
4. 把解析、规划、执行逻辑放到 `src/lib` 并编写单元测试；
5. 对涉及密钥的页面调用独立的 `renderSensitivePage(page)`，确保敏感 bundle 不包含分析 SDK。

## 安全边界

- 私钥在浏览器当前页面中解析和签名，不写入 localStorage、sessionStorage、IndexedDB，也不发送到本站服务器。
- 敏感归集页面关闭站点分析组件；错误信息会隐藏私钥和 RPC 地址。
- EVM 交易严格执行 `simulateContract → writeContract → waitForTransactionReceipt`；SOL 逐钱包实时读取余额和手续费后再签名。
- 结果导出只包含地址、资产、金额、状态和交易哈希，不包含密钥。
- 当前版本不是经过安全审计的托管产品。主网使用前请先在测试网或小额钱包验证，并优先使用专门的操作钱包。

后续演进见 [ROADMAP.md](./ROADMAP.md)。
