export type RendererSaveState = 'idle' | 'saving' | 'error';

export interface FileRendererProps {
  /**
   * The current value to display in the renderer. May include in-flight user
   * edits that haven't been saved yet (kept across tab switches by the
   * workspace hook).
   */
  content: string;
  /**
   * The bytes currently on disk. The renderer derives `dirty = content !==
   * savedContent`. When omitted, falls back to `content` (matching the
   * single-file legacy behavior). Required for multi-tab + cache-per-tab to
   * compute dirty correctly after a tab remount.
   */
  savedContent?: string;
  filePath: string;
  onSave: (content: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Fires whenever the user-edited value changes. The hook caches this on the
   * active tab so typed-but-unsaved bytes survive a tab switch.
   */
  onValueChange?: (value: string) => void;
  onSaveStateChange?: (state: RendererSaveState) => void;
  readOnly?: boolean;
}
