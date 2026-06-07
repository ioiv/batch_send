import { BrandHeader, SkipLink } from "../components/BrandHeader";

export function HomePage() {
  return (
    <>
      <SkipLink />
      <main className="shell home-shell page-home" id="main">
        <BrandHeader eyebrow="chain tools" title="批量分发工作台" />
        <section className="home" aria-labelledby="hero-title">
          <div className="hero home-hero">
            <div className="hero-copy">
              <p className="eyebrow">地址整理 / SOL 分发 / EVM 分发</p>
              <h2 id="hero-title">把地址清单整理好，再按需要进入分发。</h2>
              <p className="lead">
                输入多行地址和统一金额，生成 <code>地址,金额</code> 格式；Solana 和 EVM 分发分别进入独立页面。
              </p>
              <div className="actions">
                <a className="button primary" href="format-generator.html">
                  开始格式生成
                </a>
              </div>
            </div>

            <div className="tool-grid" aria-label="工具入口">
              <a className="tool-card primary-tool" href="format-generator.html">
                <span>01</span>
                <strong>格式生成</strong>
                <small>地址清单整理</small>
              </a>
              <a className="tool-card" href="batch-distributor.html">
                <span>02</span>
                <strong>SOL 分发</strong>
                <small>Solana 钱包确认</small>
              </a>
              <a className="tool-card" href="evm-batch-distributor.html">
                <span>03</span>
                <strong>EVM 分发</strong>
                <small>原生币批量发送</small>
              </a>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
