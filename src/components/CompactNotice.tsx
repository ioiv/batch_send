import { Children, Fragment, isValidElement, type ComponentProps, type ReactNode } from "react";
import { HelpTooltip } from "./HelpTooltip";
import { Button } from "./ui/button";

export function NoticeTitle({ children, ...props }: ComponentProps<"span">) {
  return <span {...props}>{children}</span>;
}

export function NoticeDetail({ children, ...props }: ComponentProps<"div">) {
  return <div {...props}>{children}</div>;
}

function flattenChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
    ? flattenChildren(child.props.children)
    : [child]);
}

function isAction(node: ReactNode) {
  if (!isValidElement<{ onClick?: unknown; href?: unknown; onChange?: unknown }>(node)) return false;
  return node.type === Button || ["button", "a", "input", "select", "textarea"].includes(String(node.type))
    || Boolean(node.props.onClick || node.props.href || node.props.onChange);
}

export function CompactNotice({ children, summary, tone, variant, className = "", role, ...props }: ComponentProps<"div"> & {
  summary?: ReactNode;
  tone?: "info" | "warning" | "error" | "success";
  variant?: "default" | "destructive";
}) {
  const nodes = flattenChildren(children);
  const titles = nodes.filter((node) => isValidElement(node) && node.type === NoticeTitle);
  const details = nodes.filter((node) => isValidElement(node) && node.type === NoticeDetail);
  const compound = titles.length > 0 || details.length > 0;
  const visibleSummary = summary ?? (titles.length ? titles : undefined);
  const information = compound ? details : nodes.filter((node) => !isAction(node));
  const actions = compound ? nodes.filter((node) => !isValidElement(node) || (node.type !== NoticeTitle && node.type !== NoticeDetail)) : nodes.filter(isAction);
  const effectiveTone = tone ?? (variant === "destructive" ? "error" : "info");
  const titleText = titles.map((node) => isValidElement<{ children?: ReactNode }>(node) && typeof node.props.children === "string" ? node.props.children : "").filter(Boolean).join("，");

  return (
    <div {...props} className={`compact-notice ${className}`.trim()} data-tone={effectiveTone} role={role ?? (effectiveTone === "error" ? "alert" : visibleSummary ? "status" : undefined)}>
      {visibleSummary ? <span className="compact-notice__summary">{visibleSummary}</span> : null}
      {information.length ? <HelpTooltip label={titleText || "详细说明"}>{information}</HelpTooltip> : null}
      {actions.length ? <div className="compact-notice__actions">{actions}</div> : null}
    </div>
  );
}
