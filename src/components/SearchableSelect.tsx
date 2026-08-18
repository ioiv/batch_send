import { useMemo } from "react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList
} from "@/components/ui/combobox";

export type SearchableSelectOption<T extends string> = {
  keywords?: readonly string[];
  label: string;
  meta?: string;
  value: T;
};

type SearchableSelectProps<T extends string> = {
  disabled?: boolean;
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
  disabled = false,
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
  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value]
  );

  return (
    <Combobox<SearchableSelectOption<T>>
      disabled={disabled}
      filter={(option, query) => filterSearchableSelectOptions(options, query)
        .some((candidate) => candidate.value === option.value)}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      items={options}
      onValueChange={(option) => {
        if (option && option.value !== value) onChange(option.value);
      }}
      value={selectedOption}
    >
      <ComboboxInput
        aria-label={searchable ? searchLabel : triggerLabel}
        className="searchable-select-trigger"
        disabled={disabled}
        id={id}
        placeholder={selectedOption?.label || placeholder}
        readOnly={!searchable}
        showClear={false}
        triggerAriaLabel={triggerLabel}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList aria-label={listboxLabel}>
          <ComboboxCollection>
            {(option: SearchableSelectOption<T>) => (
              <ComboboxItem key={option.value} value={option}>
                <span className="searchable-select-option__label">{option.label}</span>
                {option.meta ? (
                  <span className="searchable-select-option__meta">
                    <span className="sr-only">{metaLabel}: </span>
                    {metaPrefix}{option.meta}
                  </span>
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxCollection>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
