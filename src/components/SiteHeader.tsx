import type { ReactNode } from "react";
import { getToolById, getToolsByCategory, toolCategories } from "@/config/tools";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger
} from "@/components/ui/navigation-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";

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

export interface SiteHeaderProps {
  currentToolId?: string;
  action?: ReactNode;
}

export function SiteHeader({ currentToolId, action }: SiteHeaderProps) {
  const currentTool = getToolById(currentToolId);

  return (
    <>
      <a className="site-skip-link" href="#main">跳到主要内容</a>
      <header className="site-header">
        <div className="site-header__inner">
          <a className="site-brand" href="/" aria-label="ChainKit 首页">
            <span className="site-brand__mark"><SiteLogo /></span>
            <span className="site-brand__copy">
              <strong>ChainKit</strong>
              <small>链上工具箱</small>
            </span>
          </a>

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
              <NavigationMenuItem>
                <NavigationMenuTrigger>全部工具</NavigationMenuTrigger>
                <NavigationMenuContent className="site-tool-menu__panel">
                  {toolCategories.map((category) => (
                    <section key={category.id} aria-labelledby={`site-menu-${category.id}`}>
                      <strong id={`site-menu-${category.id}`}>{category.label}</strong>
                      <div className="site-tool-menu__links">
                        {getToolsByCategory(category.id).map((tool) => (
                          <NavigationMenuLink
                            active={currentToolId === tool.id}
                            aria-current={currentToolId === tool.id ? "page" : undefined}
                            key={tool.id}
                            render={<a href={tool.href} />}
                          >
                            {tool.shortTitle}
                          </NavigationMenuLink>
                        ))}
                      </div>
                    </section>
                  ))}
                </NavigationMenuContent>
              </NavigationMenuItem>
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
              <SheetContent className="site-mobile-menu" side="right">
                <SheetHeader>
                  <SheetTitle>ChainKit</SheetTitle>
                  <SheetDescription className="sr-only">选择工具</SheetDescription>
                </SheetHeader>
                <nav aria-label="移动端站点导航">
                  {toolCategories.map((category) => (
                    <section className="site-mobile-menu__group" key={category.id}>
                      <a href={category.href}><strong>{category.label}</strong></a>
                      {getToolsByCategory(category.id).map((tool) => (
                        <a
                          aria-current={currentToolId === tool.id ? "page" : undefined}
                          data-active={currentToolId === tool.id || undefined}
                          href={tool.href}
                          key={tool.id}
                        >
                          {tool.shortTitle}
                        </a>
                      ))}
                    </section>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
    </>
  );
}
