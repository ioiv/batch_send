// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { WorkflowFeedback } from "./WorkflowFeedback";
import { AdvancedSettings } from "./WorkbenchPrimitives";

afterEach(cleanup);

it("reveals a collapsed setting before focusing the field that blocks execution", async () => {
  const user = userEvent.setup();
  render(<>
    <AdvancedSettings label="执行节奏"><label htmlFor="test-concurrency">并发钱包数</label><input id="test-concurrency" /></AdvancedSettings>
    <WorkflowFeedback requirement={{ message: "请修正并发数", targetId: "test-concurrency" }} />
  </>);
  expect(screen.queryByRole("textbox", { name: "并发钱包数" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "前往完善" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "并发钱包数" })).toHaveFocus());
});
