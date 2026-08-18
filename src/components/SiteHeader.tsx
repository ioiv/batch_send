import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolById, getToolsByCategory, toolCategories } from "../config/tools";

function SiteLogo() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M6.5 9.5 16 4l9.5 5.5L16 15 6.5 9.5Z" fill="currentColor" />
      <path d="m6.5 15.5 9.5 5.5 9.5-5.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" opacity=".68" />
      <path d="m6.5 21.5 9.5 5.5 9.5-5.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" opacity=".38" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 6h12M4 10h12M4 14h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export interface SiteHeaderProps {
  currentToolId?: string;
  action?: ReactNode;
}

export function SiteHeader({ currentToolId, action }: SiteHeaderProps) {
  const currentTool = getToolById(currentToolId);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDetailsElement>(null);
  const toolMenuRef = useRef<HTMLDetailsElement>(null);
  const closeMobileMenu = () => setMobileMenuOpen(false);
  const closeToolMenu = () => setToolMenuOpen(false);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (mobileMenuOpen && !mobileMenuRef.current?.contains(event.target)) setMobileMenuOpen(false);
      if (toolMenuOpen && !toolMenuRef.current?.contains(event.target)) setToolMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!mobileMenuOpen && !toolMenuOpen)) return;
      event.preventDefault();
      const menuToFocus = mobileMenuOpen ? mobileMenuRef.current : toolMenuRef.current;
      setMobileMenuOpen(false);
      setToolMenuOpen(false);
      menuToFocus?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileMenuOpen, toolMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <a className="site-skip-link" href="#main">
        跳到主要内容
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <a className="site-brand" href="/" aria-label="ChainKit 链上工具箱首页">
            <span className="site-brand__mark"><SiteLogo /></span>
            <span className="site-brand__copy">
              <strong>ChainKit</strong>
              <small>链上工具箱</small>
            </span>
          </a>

          <nav className="site-nav" aria-label="站点主导航">
            <a href="/#popular">热门工具</a>
            {toolCategories.map((category) => (
              <a
                key={category.id}
                className={currentTool?.category === category.id ? "is-current" : undefined}
                href={category.href}
              >
                {category.label}
              </a>
            ))}
            <details
              className="site-tool-menu"
              onToggle={(event) => {
                setToolMenuOpen(event.currentTarget.open);
                if (event.currentTarget.open) setMobileMenuOpen(false);
              }}
              open={toolMenuOpen}
              ref={toolMenuRef}
            >
              <summary aria-expanded={toolMenuOpen}>
                全部工具
                <ChevronIcon />
              </summary>
              <div className="site-tool-menu__panel">
                {toolCategories.map((category) => (
                  <section key={category.id} aria-labelledby={`site-menu-${category.id}`}>
                    <div className="site-tool-menu__heading" id={`site-menu-${category.id}`}>
                      <strong>{category.label}</strong>
                      <span>{category.description}</span>
                    </div>
                    <div className="site-tool-menu__links">
                      {getToolsByCategory(category.id).map((tool) => (
                        <a
                          key={tool.id}
                          aria-current={currentToolId === tool.id ? "page" : undefined}
                          className={currentToolId === tool.id ? "is-current" : undefined}
                          href={tool.href}
                          onClick={closeToolMenu}
                        >
                          {tool.shortTitle}
                          <span aria-hidden="true">↗</span>
                        </a>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </details>
          </nav>

          <div className="site-header__actions">
            {action ? <div className="site-header__action">{action}</div> : null}
            <details
              className="site-mobile-menu"
              onToggle={(event) => {
                setMobileMenuOpen(event.currentTarget.open);
                if (event.currentTarget.open) setToolMenuOpen(false);
              }}
              open={mobileMenuOpen}
              ref={mobileMenuRef}
            >
              <summary
                aria-expanded={mobileMenuOpen}
                aria-label={mobileMenuOpen ? "关闭站点菜单" : "打开站点菜单"}
              >
                <MenuIcon />
              </summary>
              <nav aria-label="移动端站点导航">
                <a href="/#popular" onClick={closeMobileMenu}>热门工具</a>
                {toolCategories.map((category) => (
                  <div className="site-mobile-menu__group" key={category.id}>
                    <a
                      className={currentTool?.category === category.id ? "is-current" : undefined}
                      href={category.href}
                      onClick={closeMobileMenu}
                    >
                      <strong>{category.label}</strong>
                      <span>{category.description}</span>
                    </a>
                    {getToolsByCategory(category.id).map((tool) => (
                      <a
                        key={tool.id}
                        aria-current={currentToolId === tool.id ? "page" : undefined}
                        className={currentToolId === tool.id ? "is-current" : undefined}
                        href={tool.href}
                        onClick={closeMobileMenu}
                      >
                        {tool.shortTitle}
                      </a>
                    ))}
                  </div>
                ))}
              </nav>
            </details>
          </div>
        </div>
      </header>
      <div className="site-header-offset" aria-hidden="true" />
    </>
  );
}
