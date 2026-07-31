import { Clock } from 'lucide-react';

/**
 * App-wide demo notice. Renders for every authenticated user to make clear the
 * deployment is an evaluation copy and to carry a real expiry date — the gentle
 * urgency cue for converting from the free demo to a paid plan.
 *
 * The expiry is per-tenant, set via the `DEMO_EXPIRY` env var (an ISO date such
 * as `2026-07-06`), injected into the bundle by Vite `define`. When the var is
 * unset or unparseable the banner does not render at all — production tenants
 * simply leave it blank.
 */
// Module-scoped declaration: the `process.env.DEMO_EXPIRY` token below is
// statically replaced by the consuming bundler (Vite `define`), so this file
// must typecheck without @types/node — consumers of this raw-source package
// don't necessarily load node typings in their browser tsconfig.
declare const process: { env: Record<string, string | undefined> };

const rawExpiry = process.env.DEMO_EXPIRY ?? '';
const parsed = rawExpiry ? new Date(rawExpiry) : null;
const DEMO_EXPIRY = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

const EXPIRY_LABEL = DEMO_EXPIRY?.toLocaleDateString(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function DemoBanner() {
  // No expiry configured for this tenant → not a demo deployment.
  if (!DEMO_EXPIRY) return null;

  const now = new Date();
  const msLeft = DEMO_EXPIRY.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  const expired = msLeft <= 0;

  return (
    <div
      role="status"
      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm shrink-0"
    >
      <Clock size={16} className="shrink-0" />
      <span className="flex-1">
        <span className="font-semibold">Demo version.</span>{' '}
        {expired ? (
          <>This demo expired on {EXPIRY_LABEL}. Contact Bevel to keep your knowledge base live.</>
        ) : (
          <>
            This is a free evaluation that expires on {EXPIRY_LABEL}
            {daysLeft <= 14 && ` (${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left)`}.
          </>
        )}
      </span>
    </div>
  );
}
