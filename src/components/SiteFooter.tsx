export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container site-footer__inner">
        <div className="site-footer__brand">
          <strong>ChainKit</strong>
          <span>给高频链上操作一个清晰、可核对的工作台。</span>
        </div>
        <nav className="site-footer__nav" aria-label="页脚导航">
          <a href="/">首页</a>
          <a href="/#collection">资产归集</a>
          <a href="/#distribution">批量发送</a>
          <a href="/#security">安全说明</a>
        </nav>
        <p className="site-footer__note">
          © {new Date().getFullYear()} ChainKit · 使用工具前请核对网络、地址与交易内容
        </p>
      </div>
    </footer>
  );
}
