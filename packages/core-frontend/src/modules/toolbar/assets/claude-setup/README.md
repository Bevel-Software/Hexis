# Cowork setup screenshots

The eleven shots behind the "Cowork and claude.ai" steps — the personal
carousel on the External agent access page, and the registration carousel in
Deployment → Marketplace, which ends on the same connector slide.
`../../components/claude-setup-shots.ts` pairs each with its alt text and the
percentage rectangle drawn over the control to click.

`01` through `09` were captured on a real deployment (Claude's admin
settings, Claude Code on the web, then Cowork), so the recipe below is what a
re-shoot has to repeat.

## Processing

Source frames `01` through `08` are full-window mockups, 1999x1588, with a
device frame on a black field.

1. **Redact.** This package is published, so every deployment shows these.
   Gaussian blur, radius 9, over: the account row in the sidebar footer of
   all eight, the two "Linked by ..." lines and the personal-account and
   third-party organisation rows in `03`, and the organisation chips in `01`.
   The vendor's own organisation stays legible; nothing else does.
2. **Crop** to the window, `(99, 72, 1901, 1462)`, dropping the frame.
3. **Scale** to 1400px wide (Lanczos) and encode webp at q80. That is about
   35 to 65 KB each, and roughly 2x the ~700px column they render into.

Redact before scaling: blur radius is in source pixels.

`09-select-repository.webp` came from an 1806x1376 Claude Code screenshot.
Blur the personal name in the greeting and account row, then crop away the
outer device frame and shadow so the Claude viewport runs edge to edge like
shots `01` through `08`. Crop the normalized source at `(67, 55, 1277, 989)`,
scale that 1210x934 viewport to 1400x1080, and encode it as webp at q80.

## The two connector shots

`10-connector-not-added.webp` and `11-add-custom-connector.webp` are
**placeholder renderings**, not captures: they were drawn to the layout of the
screens they describe rather than photographed on a deployment. Replace them
with real captures when the connector flow is next in front of a camera. Until
then the alt text, not the pixels, is what the step relies on.

They are 1400x700, not 1400x1080: a plugin panel and a dialog are not the
shape of a full window, and padding them to the window shots' height would
reserve a column of empty space before the bytes land. That is what the
optional `width`/`height` on `Shot` is for — a shot that omits them is the
default 1400x1080. A re-shoot may land on any size, as long as the file and
the two numbers agree.

Same processing otherwise: redact first, then scale to 1400px wide (Lanczos)
and encode webp at q80.

## Highlights

Measure against the final image at its own size and convert each box to
percentages, with 6px of padding on each side. Percentages keep the callout
aligned when the shot renders in a narrower column. When a shot is replaced,
re-measure and update `claude-setup-shots.ts`; nothing reads the numbers from
the file.
