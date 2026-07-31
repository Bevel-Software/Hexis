import { useState } from 'react';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { useAdmin } from '../state/admin.context';
import { RolesApiError } from '../services/roles.api';

/**
 * App-wide break-glass banner shown when `roles.yaml` fails to parse. A
 * corrupted roles file is an app-wide admin lockout (the resolver hard-throws,
 * so nobody resolves as admin and most surfaces 500). It renders for EVERY
 * authenticated user — the backend recovery endpoint self-gates on the file
 * actually being corrupted, and the "only press if you are from Bevel" copy is
 * the honour-system layer on top of that hard gate.
 */
export function RolesCorruptedBanner() {
  const { rolesConfigCorrupted, rolesConfigErrors, runRolesRecovery } = useAdmin();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!rolesConfigCorrupted) return null;

  const onRecover = async () => {
    if (running) return;
    const confirmed = window.confirm(
      'Bevel Recovery will back up the corrupted roles.yaml to old-roles.yaml and ' +
        'restore the default Bevel roster. Only continue if you are from Bevel. Proceed?',
    );
    if (!confirmed) return;
    setRunning(true);
    setError(null);
    try {
      await runRolesRecovery();
      // Reload so every view re-fetches with working access now that the
      // lockout is cleared.
      window.location.reload();
    } catch (err) {
      setRunning(false);
      if (err instanceof RolesApiError && err.status === 409) {
        // Someone else already recovered (file now parses) — just reload.
        window.location.reload();
        return;
      }
      setError(err instanceof Error ? err.message : 'Recovery failed. Please try again.');
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-col gap-1 px-4 py-2.5 bg-red-600 text-white text-sm shrink-0"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={16} className="shrink-0" />
        <span className="flex-1 font-semibold">
          Roles file corrupted — contact Bevel for assistance.
        </span>
        <button
          type="button"
          onClick={onRecover}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded bg-white/15 hover:bg-white/25 disabled:opacity-60 px-2.5 py-1 text-xs font-medium border border-white/30"
        >
          {running && <Loader2 size={12} className="animate-spin" />}
          {running ? 'Recovering…' : 'Bevel Recovery — only press if you are from Bevel'}
        </button>
      </div>
      {rolesConfigErrors.length > 0 && (
        <span className="pl-6 text-xs text-red-100/90 font-mono break-all">
          {rolesConfigErrors.join('; ')}
        </span>
      )}
      {error && <span className="pl-6 text-xs text-red-100">{error}</span>}
    </div>
  );
}
