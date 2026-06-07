import { BrandHeader, SkipLink } from "../components/BrandHeader";

export function HomePage() {
  return (
    <>
      <SkipLink />
      <main className="shell home-shell page-home" id="main">
        <BrandHeader eyebrow="chain tools" title="批量分发工作台" />
        <section className="home" aria-labelledby="hero-title">
          <div className="hero">
            <p className="eyebrow">地址整理 / SOL 分发 / EVM 分发</p>
            <h2 id="hero-title">把地址清单整理好，再按需要进入分发。</h2>
            <p className="lead">
              输入多行地址和统一金额，生成 <code>地址,金额</code> 格式；Solana 和 EVM 分发分别进入独立页面。
            </p>
            <div className="actions">
              <a className="button primary" href="format-generator.html">
                开始格式生成
              </a>
              <a className="button" href="batch-distributor.html">
                SOL 分发
              </a>
              <a className="button" href="evm-batch-distributor.html">
                EVM 分发
              </a>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
