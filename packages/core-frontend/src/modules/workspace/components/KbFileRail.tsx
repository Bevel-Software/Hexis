import { Link2 } from 'lucide-react';
import type { AccessEligible } from '../../access/api';
import { Badge } from '../../../shared/components';
import type { LinkOut } from '../hooks/useLinksOut';

/**
 * "About this file" — the facts the client can PROVE about the open document
 * (proto:3859-3875).
 *
 * Every row here is derived from something already on the wire; nothing is
 * fetched to fill a slot, and no row renders when it cannot be filled. That is
 * the rule the rail lives by: a metadata panel that shows "—" for half its
 * rows teaches people to stop reading it.
 */
export interface KbFileRailProps {
  path: string;
  /**
   * UTF-16 code units of the loaded text, or null when unknowable (binary, or
   * not yet loaded). NOT bytes — see the row's own note for why it is labelled
   * "Characters" rather than "Size".
   */
  charCount: number | null;
  lastCommit: { author: string; relative: string } | null;
  /* Spelled out rather than `ReturnType<typeof useFileAccess>`: importing a
     hook into a props type couples the rail to the hook's whole shape, and
     three of that shape's five fields are nothing to do with the rail. */
  owners: AccessEligible;
  /** Derived from the content; may be empty, which renders as no section. */
  linksOut: LinkOut[];
  onOpen(target: string): void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-20 flex-none text-meta text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1 text-detail text-ink-muted">{children}</span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-label uppercase text-ink-faint">{children}</div>;
}

/** "Owned by Ali Raza", "Everyone can read" — whichever the access tree says. */
function ownersLabel(owners: AccessEligible): string | null {
  const names = [...owners.roles, ...owners.users.map((u) => u.name || u.email)];
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

export function KbFileRail({
  path,
  charCount,
  lastCommit,
  owners,
  linksOut,
  onOpen,
}: KbFileRailProps) {
  const access = ownersLabel(owners);

  return (
    <div className="border-l border-line pl-5">
      <SectionHeading>About this file</SectionHeading>
      <div className="divide-y divide-line">
        {/* Never truncated. A truncated path is unusable for the one thing
            anyone copies a path for, so it wraps instead. */}
        <Row label="Path">
          <span className="block font-mono text-meta break-all text-ink-muted">{path}</span>
        </Row>
        {/* "Characters", not "Size". `openFileContent` is a string, so its
            length is UTF-16 code units — an em-dash, an accented name or an
            emoji makes it diverge from bytes. A real byte figure is a `stat`
            field on an endpoint that does not carry one yet, and the rail will
            not print a number it cannot compute. */}
        {charCount !== null && <Row label="Characters">{charCount.toLocaleString()}</Row>}
        {lastCommit && (
          <Row label="Edited">
            {lastCommit.relative} by {lastCommit.author}
          </Row>
        )}
        {access && (
          <Row label="Access">
            <Badge tone="outline">{access}</Badge>
          </Row>
        )}
      </div>

      {linksOut.length > 0 && (
        <>
          <div className="mt-6">
            <SectionHeading>Links out</SectionHeading>
          </div>
          <div className="flex flex-col gap-0.5">
            {linksOut.map((link) => (
              <button
                key={link.target}
                type="button"
                title={link.target}
                onClick={() => onOpen(link.target)}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-detail text-ink-muted transition-colors hover:bg-hover hover:text-ink"
              >
                <Link2 size={13} className="flex-none text-ink-faint" />
                <span className="min-w-0 truncate">{link.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
