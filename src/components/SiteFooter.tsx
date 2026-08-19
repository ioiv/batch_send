export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container site-footer__inner">
        <strong>ChainKit</strong>
        <p className="site-footer__note">© {new Date().getFullYear()} ChainKit</p>
      </div>
    </footer>
  );
}
