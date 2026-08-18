import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolPageLayout } from "./ToolPageLayout";

const steps = [
  { label: "准备", description: "填写配置" },
  { label: "确认", description: "核对预检" },
  { label: "执行", description: "提交交易" }
];

describe("ToolPageLayout", () => {
  it("renders explicit completion and error states instead of leaving the last step active", () => {
    const markup = renderToStaticMarkup(
      <ToolPageLayout
        activeStep={1}
        categoryHref="/#distribution"
        categoryLabel="批量发送"
        currentToolId="sol-distribution"
        description="测试流程"
        eyebrow="Test"
        stepStates={["complete", "complete", "error"]}
        steps={steps}
        title="测试工具"
      >
        <div>内容</div>
      </ToolPageLayout>
    );

    expect(markup.match(/is-complete/g)).toHaveLength(2);
    expect(markup).toContain("site-tool-step is-error");
    expect(markup).toContain("需要处理错误");
    expect(markup).toContain(">!</span>");
  });
});
