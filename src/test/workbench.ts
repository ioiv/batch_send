import { fireEvent, screen } from "@testing-library/react";

export function expandSettings(name: string) {
  const trigger = screen.getByRole("button", { name });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

export function expandTaskDetails() {
  const trigger = screen.getByText("任务详情", { selector: "summary" });
  if (!trigger.closest("details")?.open) fireEvent.click(trigger);
}
