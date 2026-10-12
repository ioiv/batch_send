import "./tool-search.css";
import { useEffect, useId, useRef, useState } from "react";
import { tools } from "@/config/tools";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

export function ToolSearch({ mobile = false }: { mobile?: boolean }) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = tools.filter(tool => !normalized || [tool.title, tool.shortTitle, tool.description, ...tool.keywords]
    .some(value => value.toLocaleLowerCase().includes(normalized)));
  const shortcut = typeof navigator !== "undefined" && /Win|Linux/.test(navigator.platform) ? "Ctrl K" : "⌘K";

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-${matches[activeIndex]?.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, id, matches[activeIndex]?.id]);

  useEffect(() => {
    if (mobile) return;
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"
        && !window.matchMedia("(max-width: 48rem)").matches) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [mobile]);

  return (
    <form className={`site-tool-search${mobile ? " site-tool-search--mobile" : ""}`} role="search"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onSubmit={event => {
        event.preventDefault();
        const selected = activeIndex >= 0 ? matches[activeIndex] : matches.length === 1 ? matches[0]
          : matches.find(tool => tool.title.toLocaleLowerCase() === normalized);
        if (selected && open) window.location.assign(selected.href);
        else setOpen(true);
      }}>
      <InputGroup>
        <InputGroupAddon className="site-tool-search__icon">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.75" cy="8.75" r="4.75" stroke="currentColor" strokeWidth="1.5" /><path d="m12.25 12.25 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </InputGroupAddon>
        <InputGroupInput aria-label="搜索工具" role="combobox" aria-autocomplete="list"
          aria-expanded={open} aria-controls={open ? `${id}-options` : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${id}-${matches[activeIndex]?.id}` : undefined}
          aria-describedby={open ? `${id}-message` : undefined}
          autoComplete="off" placeholder="搜索工具、链或功能" ref={inputRef} type="search" value={query}
          onFocus={() => setOpen(true)}
          onChange={event => { setQuery(event.target.value); setActiveIndex(-1); setOpen(true); }}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); setActiveIndex(-1); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); setOpen(true);
              setActiveIndex(current => matches.length ? (current + (event.key === "ArrowDown" ? 1 : current < 0 ? 0 : -1) + matches.length) % matches.length : -1);
            }
          }} />
        {!mobile ? <InputGroupAddon align="inline-end"><kbd aria-hidden="true">{shortcut}</kbd></InputGroupAddon> : null}
      </InputGroup>
      {open ? <div className="site-tool-search__results">
        <p id={`${id}-message`} role="status">{matches.length ? `${matches.length} 个工具 · 选择后进入` : "没有匹配的工具，试试 EVM、SOL 或归集"}</p>
        <ul id={`${id}-options`} role="listbox" aria-label="工具搜索结果">
          {matches.map((tool, index) => <li key={tool.id} role="presentation">
            <a id={`${id}-${tool.id}`} href={tool.href} role="option" aria-selected={activeIndex === index}
              tabIndex={-1} onMouseDown={event => event.preventDefault()} onMouseMove={() => setActiveIndex(index)}>
              <span className="site-tool-search__result-heading"><strong>{tool.title}</strong><small>{tool.ecosystems.includes("evm") ? "EVM" : "Solana"}</small></span>
              <span>{tool.description}</span>
            </a>
          </li>)}
        </ul>
      </div> : null}
    </form>
  );
}
