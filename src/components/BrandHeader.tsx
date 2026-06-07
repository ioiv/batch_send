import type React from "react";

function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 7.2h12l-3 3H3l3-3Z" fill="currentColor" opacity="0.92" />
      <path d="M6 13h12l-3 3H3l3-3Z" fill="currentColor" opacity="0.72" />
      <path d="M9 18.8h12l-3 3H6l3-3Z" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

export function BrandHeader({
  eyebrow,
  title,
  subtitle,
  nav,
  wallet
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  nav?: React.ReactNode;
  wallet?: React.ReactNode;
}) {
  const action = wallet ?? nav;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          <BrandMark />
        </div>
        <div className="brand-copy">
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
      </div>
      {action ? <div className="topbar-actions">{action}</div> : null}
    </header>
  );
}

export function NavLinks({ current }: { current?: "home" | "format" | "distributor" | "evmDistributor" }) {
  return (
    <nav className="nav" aria-label="页面导航">
      <a aria-current={current === "home" ? "page" : undefined} href="/">
        入口
      </a>
      <a aria-current={current === "format" ? "page" : undefined} href="/format/">
        去生成
      </a>
      <a aria-current={current === "distributor" ? "page" : undefined} href="/sol/">
        SOL 分发
      </a>
      <a aria-current={current === "evmDistributor" ? "page" : undefined} href="/evm/">
        EVM 分发
      </a>
    </nav>
  );
}

export function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      跳过导航
    </a>
  );
}
