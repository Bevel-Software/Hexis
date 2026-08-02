/**
 * The design system's public surface.
 *
 * This barrel is the ONLY path anything should import a primitive from —
 * inside this package or outside it. Phase 2 of the UI migration has ~79
 * files importing these components; keeping them behind one entry point is
 * what lets the individual files be refactored later without a breaking
 * change for every consumer.
 *
 *   In-package:  import { Button } from '../../shared/components';
 *   Downstream:  import { Button } from '@bevel-software/platform-core-frontend/ui';
 *
 * Do NOT deep-import `shared/components/Button` — the `"./src/*"` export in
 * package.json makes that technically possible and permanently unsupported.
 */

export { Button, buttonClasses } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonSize } from './IconButton';

export { Surface } from './Surface';
export type { SurfaceProps, SurfaceTone, SurfaceRadius, SurfaceElevation } from './Surface';

export { ListRow } from './ListRow';
export type { ListRowProps, ListRowDensity } from './ListRow';

export { Badge } from './Badge';
export type { BadgeProps, BadgeTone, BadgeSize } from './Badge';

export { Banner } from './Banner';
export type { BannerProps, BannerTone } from './Banner';

export { TextField, TextAreaField } from './Field';
export type { TextFieldProps, TextAreaFieldProps } from './Field';

export { MenuPanel, MenuItem, MenuLabel } from './Menu';
export type { MenuPanelProps, MenuItemProps } from './Menu';

/* Pre-existing components that are part of the same surface. */
export { Dialog } from './Dialog';
export type { DialogSize } from './Dialog';
export { PageShell } from './PageShell';
export type { PageShellWidth } from './PageShell';
export { useModalLayer } from './useModalLayer';
export { useDismissableMenu } from './useDismissableMenu';
