# ChainKit 链上工具箱

ChainKit 是一个基于 React、TypeScript 和 Vite 的多链工具站。目前包含 SOL / EVM 批量发送、CreateX 部署，以及 ERC20、EVM NFT 与 Solana SOL / SPL Token 归集工作台。

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
| EVM NFT 归集 | `/evm/nft-collect/` | 支持 `1,3,8-12` 批量 ID、TXT / CSV，以及纯 RPC 的 Enumerable/Token ID 直接探测，也可直接编辑 `合约地址,Token ID` |
| SOL / SPL Token 归集 | `/sol/collect/` | 密钥每行 Base58、JSON 数组或 `标签,密钥`；Token 清单留空归集 SOL，填写 Mint 后归集所列 SPL Token |

三类归集都使用“解析输入 → 可选只读余额查询 → 明确确认 → 执行时即时规划 → 本地签名 → 逐项提交与确认”的流程。失败不会中断整批任务，提交后确认异常会保留交易哈希，并提示先核对链上状态，避免盲目重发。

所有工具页统一采用“准备 → 确认 → 执行”的三阶段工作台。SOL / EVM 分发支持 TXT / CSV 导入；归集密钥支持本地 TXT / CSV / JSON 导入，文件读取后立即清空选择控件。归集结果可按状态筛选并搜索地址、备注或资产，大批量结果会展开为全宽工作区。

Solana 归集采用与 EVM 代币归集一致的可选 Token 清单：留空查询并归集 SOL，填写 Mint 后只查询并归集所列经典 SPL Token / Token-2022。余额查询不是执行前置条件；每个钱包行始终先显示原生 SOL（包括 0 或读取失败），随后才显示清单内 Token。执行时会重新读取清单内持仓，并逐一保留和校验底层 Token Account，避免同一 mint 的多个账户被遗漏。基础 Token-2022 与 TransferFee 扩展可以进入受支持路径；冻结账户、NonTransferable、已暂停的 Pausable、TransferHook、ConfidentialTransfer、需要 MemoTransfer、动态显示余额的 InterestBearing / ScaledUiAmount，以及任何客户端无法识别、尚未审计或会改变转账账户要求的扩展都会 fail-closed，不会盲目签名或提交。任一 Token Program 的持仓查询不完整时不会生成 SPL 执行计划。

SPL Token 归集会验证目标 Associated Token Account（ATA）的 owner、mint 与 Token Program。目标 ATA 不存在时，预检会把创建 ATA 所需的租金和交易网络费计入来源钱包需要持有的 SOL；原生 SOL 不足时阻断该项。归集只转移用户明确填写在 Token 清单中的余额，不会自动关闭来源 Token Account，也不会自动回收其租金。

NFT Token ID 识别只使用当前 RPC，且不读取历史事件：ERC721Enumerable 调用 `balanceOf` / `tokenOfOwnerByIndex`；普通 ERC721 优先读取 `totalSupply` 与常见铸造计数器推算 Token ID 范围，再在固定快照并发调用 `ownerOf`，并用来源钱包的 `balanceOf` 判断是否找全。无法推算范围时可填写 Token ID 起止值。ERC1155 标准没有全量 Token ID 枚举接口，需手工或通过 TXT/CSV 提供已知 ID，执行前再调用 `balanceOf` 复核余额。

六个交易入口只在预检、导入、签名、提交、确认或扫描进行中锁定相关输入。终态可直接编辑或再次识别，首次新动作会自动归档最近一轮公开结果；不确定交易仍需确认已核对链上状态后，才允许提交新的写入任务。NFT 失败行支持单项重试和“重试全部失败项”，已提交但状态不确定的交易不会进入重试集合。NFT 归集并发数由用户在 1–20 范围内设置；高于来源钱包数时只会执行现有钱包任务。

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
- Solana SPL 归集同时支持经典 Token Program 与受限的 Token-2022 安全子集；未知或会改变转账语义的扩展一律 fail-closed。
- 创建目标 ATA 所需租金和网络费必须由预检计入原生 SOL 需求；工具不会自动关闭来源 Token Account 或回收账户租金。
- 结果导出只包含地址、资产、金额、状态和交易哈希，不包含密钥。
- 浏览器任务对来源钱包、资产数量和余额读取组合数设置硬上限；超限会要求拆批，不会直接放大 RPC 或签名队列。
- 当前版本不是经过安全审计的托管产品。主网使用前请先在测试网或小额钱包验证，并优先使用专门的操作钱包。

后续演进见 [ROADMAP.md](./ROADMAP.md)。
