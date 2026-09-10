import { SHOT_HEIGHT, SHOT_WIDTH, type Shot } from './claude-setup-shots';

/**
 * A setup screenshot with the control to click boxed in red.
 *
 * The box is drawn HERE, over the image, not burned into the file: a
 * re-shot screen then costs a new file and nothing else, the outline stays
 * sharp at any column width, and one shot can carry two of them (the
 * credential form and the button that saves it).
 *
 * It is `aria-hidden` on purpose. A screen reader gets the same instruction
 * from `alt`, which names the control, so the box is decoration rather than
 * the only carrier of "click this".
 *
 * The frame links to the file so a reader can open it full size: a button
 * label in a 1400px screenshot is small once it is scaled into this column.
 *
 * `border-danger` is the design system's only red. It reads as a callout
 * here rather than an error, which is the one thing a red rectangle over a
 * screenshot can mean.
 */
export function ScreenshotStep({ shot }: { shot: Shot }) {
  return (
    <a
      href={shot.src}
      target="_blank"
      rel="noopener noreferrer"
      title="Open this screenshot full size"
      className="relative block overflow-hidden rounded-md border border-line"
    >
      <img
        src={shot.src}
        alt={shot.alt}
        loading="lazy"
        decoding="async"
        width={SHOT_WIDTH}
        height={SHOT_HEIGHT}
        className="block h-auto w-full"
      />
      {shot.boxes.map((b) => (
        <span
          key={`${b.x}-${b.y}`}
          aria-hidden="true"
          className="absolute rounded-xs border-2 border-danger"
          style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
        />
      ))}
    </a>
  );
}
