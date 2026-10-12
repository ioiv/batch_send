import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import {
  supportedEcosystems,
  getToolEcosystemLabel,
  toolCategories,
  tools,
  type ToolEcosystem,
  type ToolIcon as ToolIconName
} from "@/config/tools";

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
  if (name === "domain") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" /><ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" strokeWidth="1.5" /><path d="M3 12h18M5 7h14M5 17h14" stroke="currentColor" strokeWidth="1.5" /></svg>;
  }
  if (name === "path") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7V5h6l2 2h10v5M3 7v12h8" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="16" cy="16" r="3.5" stroke="currentColor" strokeWidth="1.5" /><path d="m18.5 18.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" strokeWidth="1.5" /><path d="M14 3v5h4M10 12h5M10 16h5" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

export function HomePage() {
  const [selectedEcosystem, setSelectedEcosystem] = useState<"all" | ToolEcosystem>("all");
  const filteredTools = useMemo(
    () => selectedEcosystem === "all"
      ? tools
      : tools.filter((tool) => tool.ecosystems.includes(selectedEcosystem)),
    [selectedEcosystem]
  );

  return (
    <div className="site-page page-home">
      <SiteHeader />
      <div className="site-content" data-region="main">
        <main className="home-main" id="main" tabIndex={-1}>
          <div className="home-heading"><div><h1>链上工具箱</h1><p>选择网络生态，找到需要的工具。</p></div>
          <Tabs
            className="home-tool-tabs"
            onValueChange={(value) => setSelectedEcosystem(value as "all" | ToolEcosystem)}
            value={selectedEcosystem}
          >
            <TabsList aria-label="按生态筛选工具">
              <TabsTrigger value="all">全部</TabsTrigger>
              {supportedEcosystems.map((ecosystem) => (
                <TabsTrigger key={ecosystem.id} value={ecosystem.id}>{ecosystem.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          </div>

          <div aria-live="polite" className="home-tool-groups">
            {toolCategories.map((category) => {
              const categoryTools = filteredTools.filter((tool) => tool.category === category.id);
              if (categoryTools.length === 0) return null;
              return (
                <section id={category.id} key={category.id} aria-labelledby={`${category.id}-title`}>
                  <h2 id={`${category.id}-title`}>{category.label}</h2>
                  <div className="home-tool-grid">
                    {categoryTools.map((tool) => (
                      <a className="home-tool-link" href={tool.href} key={tool.id}>
                        <Card className="home-tool-card" size="sm">
                          <CardHeader>
                            <CardTitle>{tool.shortTitle}</CardTitle>
                            <CardAction>
                              <Badge variant="outline">{getToolEcosystemLabel(tool)}</Badge>
                            </CardAction>
                          </CardHeader>
                          <CardContent>
                            <span className="home-tool-icon"><ToolIcon name={tool.icon} /></span>
                            <p className="home-tool-description">{tool.description}</p>
                            <span aria-hidden="true" className="home-tool-arrow">↗</span>
                          </CardContent>
                        </Card>
                      </a>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
