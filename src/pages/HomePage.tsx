import { BrandHeader, SkipLink } from "../components/BrandHeader";
import batchWorkflowHero from "../assets/batch-workflow-hero.jpg";

export function HomePage() {
  return (
    <>
      <SkipLink />
      <main className="shell home-shell page-home" id="main">
        <BrandHeader eyebrow="chain tools" title="批量分发工作台" />
        <section className="home" aria-label="批量分发工具入口">
          <div className="hero home-hero">
            <figure className="workflow-visual">
              <img src={batchWorkflowHero} alt="地址清单整理后分流到两条批量分发路径的插图" />
            </figure>

            <div className="tool-grid" aria-label="工具入口">
              <a className="tool-card primary-tool" href="/format/">
                <span>01</span>
                <strong>格式生成</strong>
                <small>地址清单整理</small>
              </a>
              <a className="tool-card" href="/sol/">
                <span>02</span>
                <strong>SOL 分发</strong>
                <small>Solana 钱包确认</small>
              </a>
              <a className="tool-card" href="/evm/">
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
