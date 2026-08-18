import { useMemo, useState } from "react";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import {
  supportedChains,
  toolCategories,
  tools,
  type ToolChain,
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
      <circle cx="9" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15" cy="12" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="18" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
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
              <span className="site-kicker">ChainKit</span>
              <h1 id="site-hero-title">批量发送，<br />资产归集。</h1>
              <div className="site-hero__actions">
                <a className="site-button site-button--primary" href="#tasks">
                  选择工具
                  <ArrowIcon />
                </a>
              </div>
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
            <a data-category={category.id} href={category.href} key={category.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{category.label}</strong>
              <b aria-hidden="true">↗</b>
            </a>
          ))}
        </nav>

        <section className="site-section site-section--tasks" id="tasks" aria-labelledby="tasks-title">
          <div className="site-container">
            <div className="site-section__heading">
              <h2 id="tasks-title">全部工具</h2>
            </div>
            <div className="site-chain-tabs" role="group" aria-label="按区块链网络筛选全部工具">
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
            <div className="site-task-list" aria-live="polite">
              {toolCategories.map((category, index) => {
                const categoryTools = filteredTools.filter((tool) => tool.category === category.id);
                return (
                  <article className="site-task-row" data-category={category.id} id={category.id} key={category.id}>
                    <div className="site-task-row__heading">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <h3>{category.label}</h3>
                    </div>
                    {categoryTools.length ? (
                      <div className="site-task-row__tools">
                        {categoryTools.map((tool) => (
                          <a data-category={tool.category} href={tool.href} key={tool.id}>
                            <span className="site-task-row__icon"><ToolIcon name={tool.icon} /></span>
                            <strong>{tool.shortTitle}</strong>
                            <small>{tool.chains.length === 1
                              ? supportedChains.find((chain) => chain.id === tool.chains[0])?.shortLabel
                              : tool.chains.includes("solana") ? "多链" : "EVM"}</small>
                            <b aria-hidden="true">↗</b>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="site-task-row__empty">当前网络暂无此类工具</p>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="site-security" id="security" aria-labelledby="security-title">
          <div className="site-container site-security__inner">
            <div className="site-security__intro">
              <h2 id="security-title">签名前预检</h2>
            </div>
            <ol className="site-security__steps">
              <li><span>01</span><strong>本地处理</strong></li>
              <li><span>02</span><strong>余额与费用</strong></li>
              <li><span>03</span><strong>交易记录</strong></li>
            </ol>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
