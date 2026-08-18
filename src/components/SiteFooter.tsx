export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container site-footer__inner">
        <div className="site-footer__brand">
          <strong>ChainKit</strong>
        </div>
        <nav className="site-footer__nav" aria-label="页脚导航">
          <a href="/">首页</a>
          <a href="/#collection">资产归集</a>
          <a href="/#distribution">批量发送</a>
          <a href="/#security">安全说明</a>
        </nav>
        <p className="site-footer__note">© {new Date().getFullYear()} ChainKit</p>
      </div>
    </footer>
  );
}
