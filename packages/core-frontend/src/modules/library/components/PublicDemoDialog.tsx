import { Button, Dialog } from '../../../shared/components';

/** Where the demo sends people who want the real thing. */
const REPO_URL = 'https://github.com/Bevel-Software/Hexis';

/**
 * What "New plugin" opens on a public-demo deployment (`isPublicDemo()`)
 * instead of the create dialog.
 *
 * Shown INSTEAD of a disabled button, deliberately: a grey button reads as
 * broken, while a click that answers earns the one sentence of why — this
 * workspace is shared with strangers, so visitors write nothing — and turns
 * the refusal into the demo's actual call to action: self-host it. The
 * backend refuses the endpoint independently (see `CoreConfig.publicDemo`),
 * so this dialog is honest UI over a real gate, not the gate itself.
 */
export function PublicDemoDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Not in this demo"
      size="md"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => window.open(REPO_URL, '_blank', 'noopener')}>
            Get your own on GitHub
          </Button>
        </>
      }
    >
      <p className="text-ui text-ink-muted">
        This demo is shared by everyone who visits, so creating plugins is turned off here —
        a visitor&apos;s plugin would become part of what every other visitor sees.
      </p>
      <p className="mt-2.5 text-ui text-ink-muted">
        Bevel is open source. Self-host your own deployment and all of this — plugins, skills,
        tools, your own agents — is yours without limits.
      </p>
    </Dialog>
  );
}
