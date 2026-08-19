import { useState, type ReactNode } from "react";
import { getToolById, getToolsByCategory, toolCategories, type ToolIcon as ToolIconName } from "@/config/tools";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList
} from "@/components/ui/navigation-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";

const SIDEBAR_STORAGE_KEY = "chainkit-sidebar-collapsed";

function SiteLogo() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M6.5 9.5 16 4l9.5 5.5L16 15 6.5 9.5Z" fill="currentColor" />
      <path d="m6.5 15.5 9.5 5.5 9.5-5.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" opacity=".68" />
      <path d="m6.5 21.5 9.5 5.5 9.5-5.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" opacity=".38" />
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

function CollapseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m12 5-5 5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolIcon({ name }: { name: ToolIconName }) {
  if (name === "send") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 12 15-7-4.5 14-3.2-5.8L4 12Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" /><path d="m11.3 13.2 3.2-3.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" /></svg>;
  }
  if (name === "collect") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h4v4H5V5Zm10 0h4v4h-4V5ZM5 15h4v4H5v-4Z" stroke="currentColor" strokeWidth="1.5" /><path d="M7 9v3h10V9M7 12v3M17 12v3m-3 5 2 2 4-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (name === "nft") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 7.5 4.4v9.2L12 21l-7.5-4.4V7.4L12 3Z" stroke="currentColor" strokeWidth="1.5" /><circle cx="10" cy="10" r="1.4" fill="currentColor" /><path d="m7.5 16 3.2-3 2.2 1.8 2.2-2.1 1.4 1.4" stroke="currentColor" strokeWidth="1.5" /></svg>;
  }
  if (name === "sol") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.2 5h13l-2.5 3h-13l2.5-3Zm0 11h13l-2.5 3h-13l2.5-3Zm1.1-5.5h13l-2.5 3h-13l2.5-3Z" fill="currentColor" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" strokeWidth="1.5" /><path d="M14 3v5h4M10 12h5M10 16h5" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

function Brand() {
  return (
    <a className="site-brand" href="/" aria-label="ChainKit 首页">
      <span className="site-brand__mark"><SiteLogo /></span>
      <span className="site-brand__copy">
        <strong>ChainKit</strong>
        <small>链上工具箱</small>
      </span>
    </a>
  );
}

function SidebarNavigation({ currentToolId, mobile = false }: { currentToolId?: string; mobile?: boolean }) {
  return (
    <nav className={`site-sidebar__nav${mobile ? " site-sidebar__nav--mobile" : ""}`} aria-label={mobile ? "移动端工具导航" : "工具导航"}>
      <div className="site-sidebar__groups">
        {toolCategories.map((category) => (
          <section className="site-sidebar__group" key={category.id} aria-labelledby={`sidebar-${mobile ? "mobile-" : ""}${category.id}`}>
            <a className="site-sidebar__group-heading" href={category.href} id={`sidebar-${mobile ? "mobile-" : ""}${category.id}`}>
              {category.label}
            </a>
            <div className="site-sidebar__links">
              {getToolsByCategory(category.id).map((tool) => (
                <a
                  aria-current={currentToolId === tool.id ? "page" : undefined}
                  className="site-sidebar__link"
                  data-active={currentToolId === tool.id || undefined}
                  href={tool.href}
                  key={tool.id}
                  title={tool.shortTitle}
                >
                  <span className="site-sidebar__icon"><ToolIcon name={tool.icon} /></span>
                  <span className="site-sidebar__link-copy">
                    <strong>{tool.shortTitle}</strong>
                    <small>{tool.ecosystems.length === 2 ? "EVM · SOL" : tool.ecosystems[0] === "evm" ? "EVM" : "SOL"}</small>
                  </span>
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </nav>
  );
}

export interface SiteHeaderProps {
  currentToolId?: string;
  action?: ReactNode;
}

export function SiteHeader({ currentToolId, action }: SiteHeaderProps) {
  const currentTool = getToolById(currentToolId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true"
  );

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <>
      <a className="site-skip-link" href="#main">跳到主要内容</a>

      <aside className="site-sidebar" data-collapsed={sidebarCollapsed || undefined}>
        <SidebarNavigation currentToolId={currentToolId} />
        <Button
          aria-expanded={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? "展开侧边导航" : "收起侧边导航"}
          className="site-sidebar__toggle"
          onClick={toggleSidebar}
          size="icon"
          title={sidebarCollapsed ? "展开侧边导航" : "收起侧边导航"}
          variant="outline"
        >
          <CollapseIcon />
        </Button>
        <p className="site-sidebar__meta"><span>ChainKit</span><span>v1.0</span></p>
      </aside>

      <header className="site-header">
        <div className="site-header__inner">
          <Brand />

          <NavigationMenu className="site-nav" aria-label="站点主导航">
            <NavigationMenuList>
              {toolCategories.map((category) => (
                <NavigationMenuItem key={category.id}>
                  <NavigationMenuLink
                    active={currentTool?.category === category.id}
                    render={<a href={category.href} />}
                  >
                    {category.label}
                  </NavigationMenuLink>
                </NavigationMenuItem>
              ))}
            </NavigationMenuList>
          </NavigationMenu>

          <div className="site-header__actions">
            {action}
            <Sheet>
              <SheetTrigger
                aria-label="打开站点菜单"
                render={<Button className="site-mobile-trigger" size="icon" variant="outline" />}
              >
                <MenuIcon />
              </SheetTrigger>
              <SheetContent className="site-mobile-menu" side="left">
                <SheetHeader>
                  <SheetTitle>ChainKit</SheetTitle>
                  <SheetDescription>选择要使用的链上工具</SheetDescription>
                </SheetHeader>
                <SidebarNavigation currentToolId={currentToolId} mobile />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
    </>
  );
}
