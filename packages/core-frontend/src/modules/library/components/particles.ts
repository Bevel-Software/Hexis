import type { LoadoutKind } from '../state/loadout';

/**
 * Particle flight from a card to its freshly-landed loadout row (Web
 * Animations API, ~14 particles, green for skills / teal for integrations) —
 * straight from the approved mock. Called after the add re-render; looks the
 * row up by its `data-loadout-key` and quietly no-ops if it isn't there
 * (e.g. reduced test DOM).
 */
export function flyParticles(fromRect: DOMRect, kind: LoadoutKind, id: string): void {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `[data-loadout-key="${CSS.escape(`${kind}:${id}`)}"]`,
    );
    if (!row) return;
    row.classList.add('lib-slot-arrive');
    const to = row.getBoundingClientRect();
    const sx = fromRect.left + fromRect.width / 2;
    const sy = fromRect.top + fromRect.height / 2;
    const ex = to.left + to.width / 2;
    const ey = to.top + to.height / 2;
    for (let i = 0; i < 14; i++) {
      const p = document.createElement('div');
      p.className = 'lib-particle' + (kind === 'integration' ? ' lib-particle-tool' : '');
      const size = 4 + Math.random() * 5;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      document.body.appendChild(p);
      // Start scattered across the card, arc upward toward the row.
      const jx = sx + (Math.random() - 0.5) * fromRect.width * 0.7;
      const jy = sy + (Math.random() - 0.5) * fromRect.height * 0.6;
      const mx = (jx + ex) / 2 + (Math.random() - 0.5) * 120;
      const my = (jy + ey) / 2 - (50 + Math.random() * 90);
      const animation = p.animate(
        [
          { transform: `translate(${jx}px,${jy}px) scale(1)`, opacity: 1 },
          { transform: `translate(${mx}px,${my}px) scale(.9)`, opacity: 0.95, offset: 0.55 },
          { transform: `translate(${ex}px,${ey}px) scale(.2)`, opacity: 0 },
        ],
        {
          duration: 480 + Math.random() * 280,
          delay: Math.random() * 100,
          easing: 'cubic-bezier(.3,.1,.3,1)',
          fill: 'forwards',
        },
      );
      animation.onfinish = () => p.remove();
    }
  });
}
