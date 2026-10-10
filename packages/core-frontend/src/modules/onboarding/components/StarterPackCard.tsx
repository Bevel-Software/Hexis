import { useState } from 'react';
import { Button } from '../../../shared/components';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useStarterPacks } from '../state/starter-packs';
import { SKIP_STARTER_PACK, type StarterPackApplied, type StarterPackSummary } from '../services/starter-packs.api';

/**
 * "What does your team do?" — what a new knowledge base's admin sees where
 * the reader's empty state would be, while the server still offers it (see
 * `useStarterPacks`): one chip per starter pack, in the server's order, and a
 * quiet way out.
 *
 * Choosing adds the pack in one commit; the tree is fetched again here rather
 * than left to the change event, and BEFORE the shared answer retires the
 * card, so the pages are in the tree by the time the ordinary empty state
 * takes over and suggests them (should that fetch fail, the change event the
 * commit sends brings the tree up to date). A refusal is said on the card
 * itself, in the server's words: toasts speak only inside the Library, and
 * "someone is editing the knowledge base right now" is exactly the sentence
 * the admin needs to read. What is under way is said in a live region too:
 * the buttons only change shape, and a screen reader would hear nothing
 * until the result.
 */
export function StarterPackCard({
  packs,
  onDone,
}: {
  packs: StarterPackSummary[];
  /** Called once the choice landed (a skip included), with what was added. */
  onDone(applied: StarterPackApplied): void;
}) {
  const { choose } = useStarterPacks();
  const { refreshFileTree } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(id: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const applied = await choose(id, (added) =>
        added.pages + added.skills > 0 ? refreshFileTree() : Promise.resolve(null),
      );
      onDone(applied);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  const skipping = busy === SKIP_STARTER_PACK;
  const adding = busy && !skipping ? packs.find((pack) => pack.id === busy) : undefined;
  const underWay = adding ? `Adding starter pages and skills for ${adding.name}…` : skipping ? 'Skipping…' : '';

  return (
    <section aria-labelledby="starter-pack-title" className="text-center">
      <h2 id="starter-pack-title" className="mb-2 text-head text-ink">
        What does your team do?
      </h2>
      <p className="mb-6 text-ui text-ink-muted">We’ll add starter pages and skills that fit.</p>
      <div role="group" aria-labelledby="starter-pack-title" className="flex flex-wrap justify-center gap-2">
        {packs.map((pack) => (
          <Button
            key={pack.id}
            size="md"
            variant="outline"
            title={pack.description}
            disabled={busy !== null}
            aria-busy={busy === pack.id}
            onClick={() => void pick(pack.id)}
          >
            {busy === pack.id ? 'Adding…' : pack.name}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-detail text-danger">
          {error}
        </p>
      )}
      <Button
        size="sm"
        variant="quiet"
        className="mt-4"
        disabled={busy !== null}
        aria-busy={skipping}
        onClick={() => void pick(SKIP_STARTER_PACK)}
      >
        {skipping ? 'Skipping…' : 'Skip, I’ll start from scratch'}
      </Button>
      {/* Always in the tree, so the region exists before it has something to say. */}
      <span role="status" aria-live="polite" className="sr-only">
        {underWay}
      </span>
    </section>
  );
}
