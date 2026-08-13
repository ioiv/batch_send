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
      <strong>开始前检查</strong>
      <p>
        先用测试网和小额钱包验证；确认目标地址、网络与资产合约。页面不会替你恢复误转资产。
      </p>
      {children}
    </aside>
  );
}
