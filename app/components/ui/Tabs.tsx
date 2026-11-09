/** An underline tab bar. Each tab carries `role="tab"`, `aria-selected` and `data-tab`. */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-0.5 overflow-x-auto border-b border-[color:var(--v3-line)] px-2.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          data-tab={tab.value}
          onClick={() => onChange(tab.value)}
          className={`cursor-pointer whitespace-nowrap border-b-2 px-3 py-2 text-[length:var(--v3-t-body)] ${
            tab.value === value
              ? 'border-[color:var(--v3-you)] text-[color:var(--v3-fg)]'
              : 'border-[color:transparent] text-[color:var(--v3-fg-2)] hover:text-[color:var(--v3-fg)]'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
