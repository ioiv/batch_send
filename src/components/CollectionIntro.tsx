import type React from "react";

export function CollectionIntro({
  chainLabel,
  description,
  eyebrow,
  title
}: {
  chainLabel: string;
  description: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <section className="collection-intro" aria-labelledby="collection-page-title">
      <div className="collection-intro-copy">
        <span className="collection-kicker">{eyebrow}</span>
        <h1 id="collection-page-title">{title}</h1>
        <p>{description}</p>
      </div>
      <div className="collection-local-badge" aria-label="密钥处理方式">
        <span>签名位置</span>
        <strong>仅当前浏览器 · {chainLabel}</strong>
      </div>
    </section>
  );
}

export function CollectionSafetyNote({ children }: { children?: React.ReactNode }) {
  return (
    <aside className="notice collection-safety-note" aria-label="归集安全提示">
      <strong>安全检查</strong>
      <p>请先小额测试，并核对网络、目标与合约。</p>
      {children}
    </aside>
  );
}
