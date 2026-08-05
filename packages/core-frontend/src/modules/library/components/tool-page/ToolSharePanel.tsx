import { Button, Dialog } from '../../../../shared/components';

/**
 * SEAM (Ali) — the tool's share panel.
 *
 * This is the SHELL only. The F-lens contents (Access / People / Link-access
 * sections and the admin fork in the footer) are Ali's work and replace the
 * `tool-share-panel-body` placeholder below.
 *
 * Frozen by the master plan — do not rename, move, or change the shape:
 *   path   `modules/library/components/tool-page/ToolSharePanel.tsx`
 *   props  { open, tool: { slug, name, path }, onClose }
 *   title  `Share tool`
 *   body   <div data-testid="tool-share-panel-body" />
 *
 * `tool` carries `slug` and `path` even though the shell renders neither: the
 * contents need the slug for the API and the repo path for the access file, and
 * changing the prop later would break the one thing this seam exists to avoid.
 */

export interface ToolSharePanelProps {
  open: boolean;
  tool: { slug: string; name: string; path: string };
  onClose(): void;
}

export function ToolSharePanel({ open, tool, onClose }: ToolSharePanelProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share tool"
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="text-body text-ink-muted">
        Access, ownership, and roles for <strong>{tool.name}</strong>.
      </p>
      <div data-testid="tool-share-panel-body" />
    </Dialog>
  );
}
