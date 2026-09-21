import { describe, expect, it } from 'vitest';
import {
  SHOT_HEIGHT,
  SHOT_WIDTH,
  addCustomConnectorShot,
  addManuallyShot,
  connectorNotAddedShot,
  installPluginsShot,
  pluginsAddShot,
  selectRepositoryShot,
} from '../claude-setup-shots';

describe('Claude setup screenshot callouts', () => {
  it('points non-admins at the repository picker trigger', () => {
    expect(selectRepositoryShot.alt).toContain('Select repository');
    expect(selectRepositoryShot.boxes).toHaveLength(1);
  });

  it('highlights both Plugins and Add before opening the marketplace menu', () => {
    expect(pluginsAddShot.boxes).toHaveLength(2);
    expect(pluginsAddShot.alt).toContain('Plugins tab');
    expect(pluginsAddShot.alt).toContain('Add button');
  });

  it('highlights the whole Hexis all row', () => {
    expect(installPluginsShot.boxes).toHaveLength(1);
    expect(installPluginsShot.boxes[0].w).toBeGreaterThan(60);
    expect(installPluginsShot.alt).toContain('whole Hexis all row');
  });

  /**
   * The connector shots. Their alt text has to name the state the reader is
   * looking for (Not added) and the control that changes it, because the red
   * rectangle is `aria-hidden` and carries none of that.
   */
  it('names the Not added row and the button that fixes it', () => {
    expect(connectorNotAddedShot.alt).toContain('Not added');
    expect(connectorNotAddedShot.alt).toContain('Add for your team');
    expect(connectorNotAddedShot.alt).toContain('Tools and data sources');
    expect(connectorNotAddedShot.boxes).toHaveLength(2);
  });

  it('names the Add custom connector dialog, its filled fields and Continue', () => {
    expect(addCustomConnectorShot.alt).toContain('Add custom connector dialog');
    expect(addCustomConnectorShot.alt).toContain('already filled in');
    expect(addCustomConnectorShot.alt).toContain('Continue');
    expect(addCustomConnectorShot.boxes).toHaveLength(2);
  });

  /**
   * Boxes are PERCENTAGES of the image, never pixels: the shots render into
   * a column much narrower than they were measured at. A box that leaves the
   * image is the tell that someone pasted pixel offsets in.
   */
  it('keeps every connector box inside the image, as a percentage', () => {
    for (const shot of [connectorNotAddedShot, addCustomConnectorShot]) {
      for (const box of shot.boxes) {
        // Both edges, not just the far one: a negative offset leaves the
        // image off the left or the top and still satisfies x + w <= 100.
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(100);
        expect(box.y + box.h).toBeLessThanOrEqual(100);
        expect(box.w).toBeGreaterThan(1);
        expect(box.h).toBeGreaterThan(1);
      }
    }
  });

  /**
   * A dialog and a plugin panel are not the shape of a full window, so they
   * carry their own intrinsic size rather than being padded to the nine
   * window shots' 1400x1080 — which is what the column reserves before the
   * bytes land.
   */
  it('lets a shot declare its own size, and leaves the window shots on the default', () => {
    expect(addManuallyShot.width).toBeUndefined();
    expect(addManuallyShot.height).toBeUndefined();
    expect(installPluginsShot.height).toBeUndefined();
    for (const shot of [connectorNotAddedShot, addCustomConnectorShot]) {
      expect(shot.width).toBe(SHOT_WIDTH);
      expect(shot.height).toBe(700);
      expect(shot.height).not.toBe(SHOT_HEIGHT);
    }
  });

  /**
   * The connector screens are drawings, not captures — nobody had the flow
   * in front of a camera when the step was written. That is declared on the
   * shot rather than left to the asset README, so the page can say it to
   * the reader; the nine real captures stay unflagged, which is what keeps
   * the note from becoming decoration on every screenshot.
   *
   * When real captures land, this flag comes off and the test flips with
   * it.
   */
  it('marks only the drawn connector shots as illustrations', () => {
    expect(connectorNotAddedShot.illustration).toBe(true);
    expect(addCustomConnectorShot.illustration).toBe(true);
    for (const shot of [addManuallyShot, installPluginsShot, pluginsAddShot, selectRepositoryShot]) {
      expect(shot.illustration).toBeUndefined();
    }
  });
});
