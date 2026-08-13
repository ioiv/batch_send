import type { ReactNode } from "react";
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
            <details className="site-tool-menu">
              <summary>
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
                          className={currentToolId === tool.id ? "is-current" : undefined}
                          href={tool.href}
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
            <details className="site-mobile-menu">
              <summary aria-label="打开站点菜单"><MenuIcon /></summary>
              <nav aria-label="移动端站点导航">
                <a href="/#popular">热门工具</a>
                {toolCategories.map((category) => (
                  <div className="site-mobile-menu__group" key={category.id}>
                    <a
                      className={currentTool?.category === category.id ? "is-current" : undefined}
                      href={category.href}
                    >
                      <strong>{category.label}</strong>
                      <span>{category.description}</span>
                    </a>
                    {getToolsByCategory(category.id).map((tool) => (
                      <a
                        key={tool.id}
                        className={currentToolId === tool.id ? "is-current" : undefined}
                        href={tool.href}
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
