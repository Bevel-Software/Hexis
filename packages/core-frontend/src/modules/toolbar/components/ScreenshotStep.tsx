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
 *
 * `width`/`height` come from the shot when it declares them: the nine window
 * shots share one shape, the connector shots are a panel and a dialog and do
 * not. They only reserve the right box before the bytes land — the image is
 * `w-full h-auto` either way — but reserving the wrong one is what makes the
 * page jump.
 *
 * A shot marked `illustration` gets a line under the frame saying it is a
 * drawing rather than a capture. It is visible text, not a `title`: the
 * reader it is for is the one holding their own Claude beside the picture,
 * and they need to be told before they conclude they are on the wrong
 * screen.
 */
export function ScreenshotStep({ shot }: { shot: Shot }) {
  const frame = (
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
        width={shot.width ?? SHOT_WIDTH}
        height={shot.height ?? SHOT_HEIGHT}
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

  if (!shot.illustration) return frame;

  // The note goes OUTSIDE the anchor. The boxes are positioned against that
  // element, so a line of text inside it would make every percentage refer
  // to a taller box than the image and slide the callouts up the screen.
  return (
    <div className="space-y-1">
      {frame}
      <p className="text-meta leading-snug text-ink-faint">
        Illustration, not a capture: this is drawn to the screen's layout, so the detail on your
        Claude may differ. The instruction above names the row and the control to look for.
      </p>
    </div>
  );
}
