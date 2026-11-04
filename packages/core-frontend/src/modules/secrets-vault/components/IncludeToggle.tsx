/**
 * Include/skip checkbox for a tool, a sign-in row or a managed connector's
 * card on the Connect page: what the agent may use. One control, so every
 * row names the choice the same way.
 */
export function IncludeToggle({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: () => void;
}) {
  const label = on
    ? 'Skip this tool (removes your saved keys and sign-ins for it)'
    : 'Include this tool';
  return (
    <input
      type="checkbox"
      checked={on}
      disabled={busy}
      onChange={onChange}
      title={label}
      aria-label={label}
      className="size-3.5 shrink-0 accent-accent disabled:opacity-40"
    />
  );
}
