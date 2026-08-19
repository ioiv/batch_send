import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolPageLayout } from "./ToolPageLayout";

describe("ToolPageLayout", () => {
  it("renders one dynamic status without a stepper", () => {
    const markup = renderToStaticMarkup(
      <ToolPageLayout
        actions={<span>清空任务</span>}
        currentToolId="sol-distribution"
        stickyActions
        status="uncertain"
        statusLabel="已提交，等待链上确认"
        title="测试工具"
      >
        <div>内容</div>
      </ToolPageLayout>
    );

    expect(markup).toContain("测试工具");
    expect(markup).toContain("已提交，等待链上确认");
    expect(markup).toContain('data-state="uncertain"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('data-sticky-actions="true"');
    expect(markup).not.toContain("操作步骤");
    expect(markup).not.toContain("site-tool-step");
  });

  it("groups the toolbar, main content and footer inside the main region", () => {
    const markup = renderToStaticMarkup(
      <ToolPageLayout currentToolId="sol-distribution" title="测试工具">
        <div>滚动内容</div>
      </ToolPageLayout>
    );
    const contentStart = markup.indexOf('class="site-content"');
    const toolbarStart = markup.indexOf('class="site-tool-toolbar"');
    const mainStart = markup.indexOf("<main", toolbarStart);
    const footerStart = markup.indexOf("<footer", mainStart);

    expect(contentStart).toBeGreaterThan(-1);
    expect(toolbarStart).toBeGreaterThan(contentStart);
    expect(toolbarStart).toBeGreaterThan(-1);
    expect(mainStart).toBeGreaterThan(toolbarStart);
    expect(footerStart).toBeGreaterThan(mainStart);
  });
});
