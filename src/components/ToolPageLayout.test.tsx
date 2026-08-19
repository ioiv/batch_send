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

  it("keeps the tool toolbar outside the scrolling main content", () => {
    const markup = renderToStaticMarkup(
      <ToolPageLayout currentToolId="sol-distribution" title="测试工具">
        <div>滚动内容</div>
      </ToolPageLayout>
    );
    const toolbarStart = markup.indexOf('class="site-tool-toolbar"');
    const toolbarEnd = markup.indexOf("</div><main", toolbarStart);
    const mainStart = markup.indexOf("<main", toolbarStart);

    expect(toolbarStart).toBeGreaterThan(-1);
    expect(toolbarEnd).toBeGreaterThan(toolbarStart);
    expect(mainStart).toBeGreaterThan(toolbarEnd);
  });
});
