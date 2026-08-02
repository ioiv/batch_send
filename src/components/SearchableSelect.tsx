import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";

export type SearchableSelectOption<T extends string> = {
  keywords?: readonly string[];
  label: string;
  meta?: string;
  value: T;
};

type SearchableSelectProps<T extends string> = {
  emptyMessage?: string;
  id: string;
  listboxLabel?: string;
  metaLabel?: string;
  metaPrefix?: string;
  onChange: (value: T) => void;
  options: readonly SearchableSelectOption<T>[];
  placeholder?: string;
  searchable?: boolean;
  searchLabel?: string;
  triggerLabel?: string;
  value: T;
};

type MenuPosition = {
  bottom?: number;
  left: number;
  maxHeight: number;
  placement: "top" | "bottom";
  top?: number;
  width: number;
};

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

export function filterSearchableSelectOptions<T extends string>(
  options: readonly SearchableSelectOption<T>[],
  query: string
) {
  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...options];

  if (/^\d+$/.test(normalizedQuery)) {
    const exactMetaMatches = options.filter((option) => normalizeSearchText(option.meta || "") === normalizedQuery);
    if (exactMetaMatches.length > 0) return exactMetaMatches;
  }

  return options.filter((option) => {
    const searchableText = normalizeSearchText([
      option.label,
      option.value,
      option.meta || "",
      ...(option.keywords || [])
    ].join(" "));

    return terms.every((term) => searchableText.includes(term));
  });
}

export function SearchableSelect<T extends string>({
  emptyMessage = "未找到匹配的选项",
  id,
  listboxLabel = "可选项",
  metaLabel = "标识",
  metaPrefix,
  onChange,
  options,
  placeholder = "搜索",
  searchable = true,
  searchLabel = "搜索选项",
  triggerLabel = "网络选择",
  value
}: SearchableSelectProps<T>) {
  const instanceId = useId();
  const listboxId = `${id}-${instanceId}-listbox`;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);

  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(
    () => searchable ? filterSearchableSelectOptions(options, query) : [...options],
    [options, query, searchable]
  );
  const safeActiveIndex = activeIndex >= 0 && activeIndex < filteredOptions.length ? activeIndex : -1;
  const activeOptionId = safeActiveIndex >= 0 ? `${listboxId}-option-${safeActiveIndex}` : undefined;

  const closeMenu = (restoreFocus = false) => {
    setIsOpen(false);
    setQuery("");
    setActiveIndex(-1);
    setMenuPosition(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = () => {
    setQuery("");
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.length > 0 ? 0 : -1);
    setIsOpen(true);
  };

  const selectOption = (option: SearchableSelectOption<T>) => {
    if (option.value !== value) onChange(option.value);
    closeMenu(true);
  };

  const focusAdjacentToTrigger = (backwards: boolean) => {
    const trigger = triggerRef.current;
    if (!trigger) {
      closeMenu(true);
      return;
    }

    const focusableElements = Array.from(document.querySelectorAll<HTMLElement>([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(","))).filter((element) => (
      !menuRef.current?.contains(element)
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden"
    ));
    const triggerIndex = focusableElements.indexOf(trigger);
    const nextIndex = backwards ? triggerIndex - 1 : triggerIndex + 1;
    const nextElement = focusableElements[nextIndex];

    closeMenu();
    requestAnimationFrame(() => (nextElement || trigger).focus());
  };

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const edge = 12;
      const gap = 8;
      const viewportLeft = visualViewport?.offsetLeft || 0;
      const viewportTop = visualViewport?.offsetTop || 0;
      const viewportWidth = visualViewport?.width || window.innerWidth;
      const viewportHeight = visualViewport?.height || window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const spaceBelow = viewportBottom - rect.bottom - gap - edge;
      const spaceAbove = rect.top - viewportTop - gap - edge;
      const placement = spaceBelow < 260 && spaceAbove > spaceBelow ? "top" : "bottom";
      const availableHeight = placement === "top" ? spaceAbove : spaceBelow;
      const maxWidth = Math.max(0, viewportWidth - edge * 2);
      const width = Math.min(Math.max(rect.width, 320), maxWidth);
      const left = Math.max(
        viewportLeft + edge,
        Math.min(rect.left, viewportRight - width - edge)
      );

      setMenuPosition({
        ...(placement === "top"
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
        left,
        maxHeight: Math.max(0, Math.min(360, availableHeight)),
        placement,
        width
      });
    };

    let updateFrame = 0;
    const scheduleMenuPositionUpdate = (event?: Event) => {
      if (event?.target instanceof Node && menuRef.current?.contains(event.target)) return;
      cancelAnimationFrame(updateFrame);
      updateFrame = requestAnimationFrame(updateMenuPosition);
    };
    const visualViewport = window.visualViewport;

    updateMenuPosition();
    window.addEventListener("resize", scheduleMenuPositionUpdate);
    window.addEventListener("scroll", scheduleMenuPositionUpdate, true);
    visualViewport?.addEventListener("resize", scheduleMenuPositionUpdate);
    visualViewport?.addEventListener("scroll", scheduleMenuPositionUpdate);

    return () => {
      cancelAnimationFrame(updateFrame);
      window.removeEventListener("resize", scheduleMenuPositionUpdate);
      window.removeEventListener("scroll", scheduleMenuPositionUpdate, true);
      visualViewport?.removeEventListener("resize", scheduleMenuPositionUpdate);
      visualViewport?.removeEventListener("scroll", scheduleMenuPositionUpdate);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !searchable) return;

    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, searchable]);

  useEffect(() => {
    if (!isOpen) return;

    const selectedIndex = query
      ? -1
      : filteredOptions.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : filteredOptions.length > 0 ? 0 : -1);
  }, [filteredOptions, isOpen, query, value]);

  useEffect(() => {
    if (!isOpen || safeActiveIndex < 0) return;

    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${safeActiveIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [isOpen, safeActiveIndex]);

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };

    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [isOpen]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      } else if (!searchable && filteredOptions.length > 0) {
        setActiveIndex((current) => {
          if (event.key === "ArrowDown") {
            return current < 0 ? 0 : (current + 1) % filteredOptions.length;
          }
          return current <= 0 ? filteredOptions.length - 1 : current - 1;
        });
      }
      return;
    }

    if (!searchable && isOpen) {
      if (event.key === "Home" && filteredOptions.length > 0) {
        event.preventDefault();
        setActiveIndex(0);
        return;
      }

      if (event.key === "End" && filteredOptions.length > 0) {
        event.preventDefault();
        setActiveIndex(filteredOptions.length - 1);
        return;
      }

      if ((event.key === "Enter" || event.key === " ") && safeActiveIndex >= 0) {
        event.preventDefault();
        selectOption(filteredOptions[safeActiveIndex]);
        return;
      }

      if (event.key === "Tab") {
        closeMenu();
        return;
      }
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeMenu(true);
    }
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }

    if (event.key === "Tab") {
      if (!event.shiftKey && query && clearButtonRef.current) {
        event.preventDefault();
        clearButtonRef.current.focus();
        return;
      }
      event.preventDefault();
      focusAdjacentToTrigger(event.shiftKey);
      return;
    }

    if (filteredOptions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => current < 0 ? 0 : (current + 1) % filteredOptions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => current <= 0 ? filteredOptions.length - 1 : current - 1);
      return;
    }

    if (event.key === "Home" && !query) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === "End" && !query) {
      event.preventDefault();
      setActiveIndex(filteredOptions.length - 1);
      return;
    }

    if (event.key === "Enter" && !event.nativeEvent.isComposing && safeActiveIndex >= 0) {
      event.preventDefault();
      selectOption(filteredOptions[safeActiveIndex]);
    }
  };

  const menuStyle: CSSProperties | undefined = menuPosition
    ? {
        bottom: menuPosition.bottom,
        left: menuPosition.left,
        maxHeight: menuPosition.maxHeight,
        top: menuPosition.top,
        width: menuPosition.width
      }
    : undefined;

  const menu = isOpen && typeof document !== "undefined"
    ? createPortal(
        <div
          className="searchable-select-menu"
          data-placement={menuPosition?.placement || "bottom"}
          data-positioned={menuPosition ? "true" : "false"}
          data-searchable={searchable ? "true" : "false"}
          ref={menuRef}
          style={menuStyle}
        >
          {searchable ? (
            <div className="searchable-select-search">
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <circle cx="8.7" cy="8.7" r="5.2" />
                <path d="m12.7 12.7 4 4" />
              </svg>
              <input
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded="true"
                aria-label={searchLabel}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={placeholder}
                ref={searchInputRef}
                role="combobox"
                spellCheck={false}
                type="search"
                value={query}
              />
              {query ? (
                <button
                  aria-label="清除搜索"
                  className="searchable-select-clear"
                  onClick={() => {
                    setQuery("");
                    searchInputRef.current?.focus();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeMenu(true);
                      return;
                    }

                    if (event.key === "Tab") {
                      event.preventDefault();
                      if (event.shiftKey) searchInputRef.current?.focus();
                      else focusAdjacentToTrigger(false);
                    }
                  }}
                  ref={clearButtonRef}
                  type="button"
                >
                  <svg aria-hidden="true" viewBox="0 0 18 18">
                    <path d="m5 5 8 8M13 5l-8 8" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : null}

          <div aria-label={listboxLabel} className="searchable-select-options" id={listboxId} role="listbox">
            {filteredOptions.length > 0 ? filteredOptions.map((option, index) => (
              <button
                aria-label={option.meta ? `${option.label}，${metaLabel} ${option.meta}` : option.label}
                aria-selected={option.value === value}
                className="searchable-select-option"
                data-active={index === safeActiveIndex ? "true" : undefined}
                data-option-index={index}
                id={`${listboxId}-option-${index}`}
                key={option.value}
                onClick={() => selectOption(option)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                tabIndex={-1}
                title={option.label}
                type="button"
              >
                <span className="searchable-select-option-label">{option.label}</span>
                {option.meta ? (
                  <span className="searchable-select-option-meta" aria-hidden="true">
                    {metaPrefix ? <span>{metaPrefix}</span> : null}
                    <strong>{option.meta}</strong>
                  </span>
                ) : null}
              </button>
            )) : (
              <div
                aria-disabled="true"
                aria-label={emptyMessage}
                aria-selected="false"
                className="searchable-select-empty"
                role="option"
              >
                <span aria-hidden="true">⌁</span>
                <strong aria-live="polite">{emptyMessage}</strong>
                <small>{searchable ? "试试链名称或 ID" : "暂无可选项"}</small>
              </div>
            )}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="searchable-select" data-open={isOpen ? "true" : "false"} ref={rootRef}>
      <button
        aria-activedescendant={!searchable && isOpen ? activeOptionId : undefined}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`${triggerLabel}：${selectedOption?.label || "请选择"}`}
        className="searchable-select-trigger"
        id={id}
        onClick={() => isOpen ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span title={selectedOption?.label}>{selectedOption?.label || "请选择"}</span>
        <svg aria-hidden="true" className="searchable-select-chevron" viewBox="0 0 18 18">
          <path d="m5 7 4 4 4-4" />
        </svg>
      </button>
      {menu}
    </div>
  );
}
