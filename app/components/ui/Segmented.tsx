export function Segmented<V extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <fieldset
      aria-label={label}
      className="m-0 inline-flex min-w-0 gap-0.5 rounded-lg border border-[color:var(--v3-line)] bg-[var(--v3-panel)] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`cursor-pointer rounded-md px-3 py-1 text-[length:var(--v3-t-meta)] ${
            option.value === value
              ? 'bg-[var(--v3-raised)] font-semibold text-[color:var(--v3-fg)]'
              : 'bg-transparent text-[color:var(--v3-fg-2)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
