import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const helpTooltipDelayMs = 450;

type HelpTooltipProps = {
  children: ReactNode;
  label: string;
};

export function HelpTooltip({ children, label }: HelpTooltipProps) {
  const tooltipId = useId();
  const hoverTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    };
  }, []);

  return (
    <span
      aria-label={label}
      className="relative inline-flex size-3.5 shrink-0 select-none items-center justify-center rounded-full bg-muted/70 text-[0.625rem] font-medium leading-none text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
      onMouseEnter={() => {
        if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = window.setTimeout(() => {
          setOpen(true);
          hoverTimerRef.current = null;
        }, helpTooltipDelayMs);
      }}
      onMouseLeave={() => {
        if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
        setOpen(false);
      }}
    >
      ?
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-50 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-border bg-popover px-3 py-2 text-left text-xs/relaxed font-normal text-popover-foreground shadow-md"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

export { helpTooltipDelayMs };
