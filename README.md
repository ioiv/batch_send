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

所有工具页采用单栏工作台：全宽钱包或收款清单在上，配置区在下，摘要与执行按钮集中在底部。桌面配置字段可成对排列，手机自动堆叠。分发摘要只显示有效地址、合计金额和预计手续费；错误与重复项仅非零时出现，点击可以定位清单问题。静态说明通过问号展开，支持悬浮、点击、键盘与触屏；动态状态保持简短并可查看详情。SOL / EVM 分发支持 TXT / CSV 导入；归集密钥支持本地 TXT / CSV / JSON 导入，文件读取后立即清空选择控件。结果、扫描详情与历史记录可折叠查看。

## 一键归集

三个归集入口均可切换「手动归集 / 一键归集」，保留当前全部来源钱包、选中项以及网络、RPC 和目标地址。密钥只通过临时内存引用交接，导入组件挂载后立即消费，页面关闭或卸载时清理。扫描只读，不签名；扫描完成后仍需确认才执行。

一键归集按全局阶段顺序执行：所有钱包 Token 完成后处理 NFT，最后按可选开关归集原生币。原生币默认关闭；扫描不完整、资产失败或跳过、仍有余额、复查失败、交易状态不确定的钱包保留原生币。每个钱包内逐笔执行，最多同时处理三个钱包。暂停和停止只影响后续操作，已提交交易继续确认；状态不确定的交易不自动重发，重新扫描或切换模式前需确认已核对链上结果。执行记录包含阶段、金额和交易哈希，可查看日志、导出 CSV，并保留最近十轮公开记录。

EVM 使用 Blockscout V2 发现 ERC-20、ERC-721 与 ERC-1155 候选资产，再通过当前 RPC 核对实时余额和所有权。Ethereum、Optimism、Gnosis、Base、Arbitrum、Sepolia 和 Base Sepolia 有默认资产索引；其他链可以填写对应的 Blockscout V2 节点。自定义索引的网络无法自动核验，因此只归集 RPC 已验证的资产，保留原生币。分页、请求或资产上限、限流、格式错误都视为扫描不完整。索引仅收到公开钱包地址，所有签名和发送使用当前选定链的 RPC。

Solana 一键扫描全部经典 SPL 和 Token-2022 账户，不需要填写 Mint 清单；同 Mint 的多个账户在概览中精确合并，但执行时逐个处理。零精度且数量为一的资产显示为 NFT；不支持压缩 NFT、Core 与需要专用流程的可编程 NFT。冻结或未知扩展资产保留并阻止该钱包的原生 SOL 归集。转移资产不会自动关闭来源 Token Account 或回收租金。

钱包资产概览最多直接显示两种 Token 的符号和简短数量，更多时显示「共 N 种 Token」，NFT 单独计数；问号内可查看精确数量及合约 / Mint。缺失符号使用缩短地址，相同符号但不同合约分别计数；未知、未扫描和扫描不完整不会显示为零资产。所有余额和汇总使用 bigint，避免大数或微小余额丢失精度。

Solana 手动归集采用与 EVM 代币归集一致的可选 Token 清单：留空查询并归集 SOL，填写 Mint 后只查询并归集所列经典 SPL Token / Token-2022。余额查询不是执行前置条件；每个钱包行始终先显示原生 SOL（包括 0 或读取失败），随后才显示清单内 Token。执行时会重新读取清单内持仓，并逐一保留和校验底层 Token Account，避免同一 mint 的多个账户被遗漏。基础 Token-2022 与 TransferFee 扩展可以进入受支持路径；冻结账户、NonTransferable、已暂停的 Pausable、TransferHook、ConfidentialTransfer、需要 MemoTransfer、动态显示余额的 InterestBearing / ScaledUiAmount，以及任何客户端无法识别、尚未审计或会改变转账账户要求的扩展都会 fail-closed，不会盲目签名或提交。任一 Token Program 的持仓查询不完整时不会生成 SPL 执行计划。

SPL Token 归集会验证目标 Associated Token Account（ATA）的 owner、mint 与 Token Program。目标 ATA 不存在时，预检会把创建 ATA 所需的租金和交易网络费计入来源钱包需要持有的 SOL；原生 SOL 不足时阻断该项。手动归集只转移用户明确填写在 Token 清单中的余额，不会自动关闭来源 Token Account，也不会自动回收其租金。

NFT Token ID 识别只使用当前 RPC，且不读取历史事件：ERC721Enumerable 调用 `balanceOf` / `tokenOfOwnerByIndex`；普通 ERC721 优先读取 `totalSupply` 与常见铸造计数器推算 Token ID 范围，再在固定快照并发调用 `ownerOf`，并用来源钱包的 `balanceOf` 判断是否找全。无法推算范围时可填写 Token ID 起止值。ERC1155 标准没有全量 Token ID 枚举接口，需手工或通过 TXT/CSV 提供已知 ID，执行前再调用 `balanceOf` 复核余额。

六个交易入口只在预检、导入、签名、提交、确认或扫描进行中锁定相关输入。终态可直接编辑、再次识别，或用“开始新一轮归集”在不改动任何设置的情况下继续；这三种动作都会把上一轮公开结果归档，归集记录最多保留最近 10 轮并可分轮导出 CSV。NFT 归档只移出确认成功的 Token ID，失败与未执行项留在清单里供下一轮使用。不确定交易仍需确认已核对链上状态后，才允许提交新的写入任务。NFT 失败行支持单项重试和“重试全部失败项”，已提交但状态不确定的交易不会进入重试集合。NFT 归集并发数由用户在 1–20 范围内设置；高于来源钱包数时只会执行现有钱包任务。

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
