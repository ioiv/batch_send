import { useMemo, useState } from "react";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import {
  featuredTools,
  getToolsByCategory,
  supportedChains,
  toolCategories,
  tools,
  type ToolChain,
  type ToolDefinition,
  type ToolIcon as ToolIconName
} from "../config/tools";

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolIcon({ name }: { name: ToolIconName }) {
  if (name === "send") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m4 12 15-7-4.5 14-3.2-5.8L4 12Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
        <path d="m11.3 13.2 3.2-3.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "collect") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 5h4v4H5V5Zm10 0h4v4h-4V5ZM5 15h4v4H5v-4Z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 9v3h10V9M7 12v3M17 12v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m14 17 2 2 4-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === "nft") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m12 3 7.5 4.4v9.2L12 21l-7.5-4.4V7.4L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="10" cy="10" r="1.4" fill="currentColor" />
        <path d="m7.5 16 3.2-3 2.2 1.8 2.2-2.1 1.4 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === "sol") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6.2 5h13l-2.5 3h-13l2.5-3Zm0 11h13l-2.5 3h-13l2.5-3Zm1.1-5.5h13l-2.5 3h-13l2.5-3Z" fill="currentColor" />
      </svg>
    );
  }

  if (name === "contract") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M14 3v5h4M10 12h5M10 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 6h14M5 12h14M5 18h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="6" r="1.8" fill="white" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15" cy="12" r="1.8" fill="white" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="18" r="1.8" fill="white" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ToolCard({ tool, prominent = false }: { tool: ToolDefinition; prominent?: boolean }) {
  const chainLabel = tool.chains.length === 1
    ? supportedChains.find((chain) => chain.id === tool.chains[0])?.label
    : tool.chains.includes("solana") ? "EVM + Solana" : "多条 EVM 网络";

  return (
    <a className={`site-tool-card${prominent ? " site-tool-card--prominent" : ""}`} href={tool.href}>
      <div className="site-tool-card__topline">
        <span className="site-tool-card__icon"><ToolIcon name={tool.icon} /></span>
        {tool.badge ? <span className="site-tool-card__badge">{tool.badge}</span> : null}
      </div>
      <div className="site-tool-card__copy">
        <span>{chainLabel}</span>
        <h3>{tool.title}</h3>
        <p>{tool.description}</p>
      </div>
      <span className="site-tool-card__link">
        打开工具
        <ArrowIcon />
      </span>
    </a>
  );
}

export function HomePage() {
  const [selectedChain, setSelectedChain] = useState<"all" | ToolChain>("all");
  const filteredTools = useMemo(
    () => selectedChain === "all" ? tools : tools.filter((tool) => tool.chains.includes(selectedChain)),
    [selectedChain]
  );

  return (
    <div className="site-page">
      <SiteHeader />
      <main id="main">
        <section className="site-hero" aria-labelledby="site-hero-title">
          <div className="site-container site-hero__inner">
            <div className="site-hero__copy">
              <span className="site-kicker">多链批量操作工作台</span>
              <h1 id="site-hero-title">把重复的链上操作，<br />收进一个工作台。</h1>
              <p>
                从资产分发到多钱包归集，先扫描、再核对、后签名。每一步都保留清晰的交易明细。
              </p>
              <div className="site-hero__actions">
                <a className="site-button site-button--primary" href="/evm/collect/">
                  开始代币归集
                  <ArrowIcon />
                </a>
                <a className="site-text-link" href="#popular">浏览热门工具 <span aria-hidden="true">↓</span></a>
              </div>
              <dl className="site-hero__facts">
                <div><dt>{tools.length}</dt><dd>项可用工具</dd></div>
                <div><dt>20+</dt><dd>条已支持网络</dd></div>
                <div><dt>本地</dt><dd>交易签名</dd></div>
              </dl>
            </div>

            <div className="site-hero__visual" aria-label="资产归集工作流示意">
              <div className="site-flow-card site-flow-card--sources">
                <span>来源钱包</span>
                <div className="site-wallet-stack" aria-hidden="true">
                  <i>0x71…A8</i><i>9ksP…2V</i><i>0x2E…D1</i>
                </div>
              </div>
              <div className="site-flow-path" aria-hidden="true"><i /><i /><i /></div>
              <div className="site-flow-orbit" aria-hidden="true">
                <span>ETH</span><span>SOL</span><span>NFT</span>
              </div>
              <div className="site-flow-card site-flow-card--target">
                <span>目标钱包</span>
                <strong>已检查 12 笔资产</strong>
                <small>等待本地签名</small>
              </div>
              <div className="site-flow-status"><i /> RPC 连接正常</div>
            </div>
          </div>
        </section>

        <nav className="site-category-strip site-container" aria-label="按任务浏览工具">
          {toolCategories.map((category, index) => (
            <a href={category.href} key={category.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{category.label}</strong>
              <small>{category.description}</small>
              <b aria-hidden="true">↗</b>
            </a>
          ))}
        </nav>

        <section className="site-section site-section--popular" id="popular" aria-labelledby="popular-title">
          <div className="site-container">
            <div className="site-section__heading">
              <div>
                <span className="site-kicker">常用入口</span>
                <h2 id="popular-title">热门工具</h2>
              </div>
              <p>直接进入最近最常用的批量发送与归集流程。</p>
            </div>
            <div className="site-tool-grid site-tool-grid--featured">
              {featuredTools.map((tool, index) => <ToolCard key={tool.id} tool={tool} prominent={index === 0} />)}
            </div>
          </div>
        </section>

        <section className="site-section site-section--tasks" aria-labelledby="tasks-title">
          <div className="site-container">
            <div className="site-section__heading">
              <div>
                <span className="site-kicker">从任务出发</span>
                <h2 id="tasks-title">需要完成什么？</h2>
              </div>
              <p>每类工具共享一套检查逻辑，后续新增功能也会归入这里。</p>
            </div>
            <div className="site-task-list">
              {toolCategories.map((category, index) => (
                <article className="site-task-row" id={category.id} key={category.id}>
                  <div className="site-task-row__heading">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><h3>{category.label}</h3><p>{category.description}</p></div>
                  </div>
                  <div className="site-task-row__tools">
                    {getToolsByCategory(category.id).map((tool) => (
                      <a href={tool.href} key={tool.id}>
                        <span className="site-task-row__icon"><ToolIcon name={tool.icon} /></span>
                        <strong>{tool.shortTitle}</strong>
                        <small>{tool.chains.length === 1 ? supportedChains.find((chain) => chain.id === tool.chains[0])?.shortLabel : "EVM"}</small>
                        <b aria-hidden="true">↗</b>
                      </a>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="site-section site-section--chains" aria-labelledby="chains-title">
          <div className="site-container">
            <div className="site-section__heading">
              <div>
                <span className="site-kicker">网络筛选</span>
                <h2 id="chains-title">按链查找</h2>
              </div>
              <p>选择目标网络，只查看当前可用的工具。</p>
            </div>
            <div className="site-chain-tabs" role="group" aria-label="筛选区块链网络">
              <button
                type="button"
                className={selectedChain === "all" ? "is-active" : undefined}
                aria-pressed={selectedChain === "all"}
                onClick={() => setSelectedChain("all")}
              >
                <i className="site-chain-dot site-chain-dot--all" />
                全部网络
              </button>
              {supportedChains.map((chain) => (
                <button
                  type="button"
                  className={selectedChain === chain.id ? "is-active" : undefined}
                  aria-pressed={selectedChain === chain.id}
                  data-chain={chain.id}
                  key={chain.id}
                  onClick={() => setSelectedChain(chain.id)}
                >
                  <i className="site-chain-dot" />
                  {chain.label}
                </button>
              ))}
            </div>
            <div className="site-tool-grid site-tool-grid--filtered" aria-live="polite">
              {filteredTools.length > 0 ? filteredTools.map((tool) => <ToolCard key={tool.id} tool={tool} />) : (
                <div className="site-empty-state">
                  <strong>该网络暂时没有可用工具</strong>
                  <p>选择“全部网络”查看当前已上线的功能。</p>
                  <button type="button" onClick={() => setSelectedChain("all")}>查看全部工具</button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="site-security" id="security" aria-labelledby="security-title">
          <div className="site-container site-security__inner">
            <div className="site-security__intro">
              <span className="site-kicker">签名前看得清</span>
              <h2 id="security-title">关键操作留在你的设备上</h2>
              <p>工具负责整理数据与构建交易，最终签名仍由你控制。提交前请逐项核对目标地址、网络和金额。</p>
            </div>
            <ol className="site-security__steps">
              <li><span>01</span><div><strong>本地处理</strong><p>导入的签名材料不发送到业务服务器。</p></div></li>
              <li><span>02</span><div><strong>交易预检</strong><p>先检查余额、网络费用与关键参数。</p></div></li>
              <li><span>03</span><div><strong>结果可追踪</strong><p>保留每笔状态与交易哈希，方便复核。</p></div></li>
            </ol>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
