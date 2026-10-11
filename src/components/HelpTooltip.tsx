import { useId, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";

export const helpTooltipDelayMs = 300;
export const helpTooltipCloseDelayMs = 150;

export function HelpTooltip({ children, label }: { children: ReactNode; label: string }) {
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root modal={false} onOpenChange={setOpen} open={open} triggerId={triggerId}>
      <Popover.Trigger
        aria-label={label.startsWith("说明：") ? label : `说明：${label}`}
        className="help-tooltip__trigger"
        closeDelay={helpTooltipCloseDelayMs}
        delay={helpTooltipDelayMs}
        id={triggerId}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        openOnHover
        ref={triggerRef}
        type="button"
      ><HugeiconsIcon aria-hidden="true" icon={InformationCircleIcon} size={14} strokeWidth={1.8} /></Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" className="help-tooltip__positioner" collisionPadding={8} side="top" sideOffset={8}>
          <Popover.Popup
            aria-label={label}
            className="help-tooltip__content"
            finalFocus
            initialFocus={false}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
