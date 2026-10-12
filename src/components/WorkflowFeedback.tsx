import "./workflow-feedback.css";
import { Button } from "./ui/button";

export type WorkflowRequirement = { message: string; targetId?: string; actionLabel?: string };

export function focusWorkflowField(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.dispatchEvent(new Event("workbench-reveal", { bubbles: true }));
  requestAnimationFrame(() => {
    const field = target.matches("input, textarea, button, [tabindex]") ? target
      : target.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, button, [tabindex]') || target;
    field.scrollIntoView?.({ block: "center", behavior: "auto" });
    field.focus({ preventScroll: true });
  });
}

export function WorkflowFeedback({ requirement }: { requirement: WorkflowRequirement | null }) {
  if (!requirement) return null;
  return <div className="workflow-feedback">
    <span role="status">{requirement.message}</span>
    {requirement.targetId ? <Button variant="link" size="sm" type="button"
      onClick={() => focusWorkflowField(requirement.targetId!)}>{requirement.actionLabel || "前往完善"}</Button> : null}
  </div>;
}
