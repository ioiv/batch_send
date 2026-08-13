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
              <a className="tool-card primary-tool" href="/sol/">
                <span>01</span>
                <strong>SOL 分发</strong>
                <small>清单生成与钱包确认</small>
              </a>
              <a className="tool-card" href="/evm/">
                <span>02</span>
                <strong>EVM 分发</strong>
                <small>原生币与 Token 批量发送</small>
              </a>
              <a className="tool-card" href="/evm/deploy/">
                <span>03</span>
                <strong>合约部署</strong>
                <small>CreateX 校验部署</small>
              </a>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
