import { buttonVariants } from "@/components/ui/button";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container site-footer__inner">
        <strong>ChainKit</strong>
        <nav className="site-footer__nav" aria-label="页脚导航">
          <a className={buttonVariants({ variant: "link" })} href="/">首页</a>
          <a className={buttonVariants({ variant: "link" })} href="/#collection">资产归集</a>
          <a className={buttonVariants({ variant: "link" })} href="/#distribution">批量发送</a>
        </nav>
        <p className="site-footer__note">© {new Date().getFullYear()} ChainKit</p>
      </div>
    </footer>
  );
}
