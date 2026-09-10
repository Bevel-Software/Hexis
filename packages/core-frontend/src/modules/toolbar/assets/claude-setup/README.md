# Cowork setup screenshots

The eight shots behind the "Cowork and claude.ai" steps on the External agent
access page. `../../components/claude-setup-shots.ts` pairs each with its alt
text and the percentage rectangle drawn over the control to click.

Captured on a real deployment (Claude's admin settings, then Cowork), so the
recipe below is what a re-shoot has to repeat.

## Processing

Source frames are full-window mockups, 1999x1588, with a device frame on a
black field.

1. **Redact.** This package is published, so every deployment shows these.
   Gaussian blur, radius 9, over: the account row in the sidebar footer of
   all eight, the two "Linked by ..." lines and the personal-account and
   third-party organisation rows in `03`, and the organisation chips in `01`.
   The vendor's own organisation stays legible; nothing else does.
2. **Crop** to the window, `(99, 72, 1901, 1462)`, dropping the frame.
3. **Scale** to 1400px wide (Lanczos) and encode webp at q80. That is about
   35 to 65 KB each, and roughly 2x the ~700px column they render into.

Redact before scaling: blur radius is in source pixels.

## Highlights

Measured in source coordinates, then converted to percentages of the CROPPED
image with 6px of padding on each side. Percentages because the shots are
scaled twice after measuring. When a shot is replaced, re-measure and update
`claude-setup-shots.ts`; nothing reads the numbers from the file.
