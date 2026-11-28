import type { ComponentType } from 'react';
import { restoreLineEndings } from '@bevel-software/platform-shared';
import type { FileRendererProps } from './types';

/** Text as a `<textarea>` holds it: every line break an LF. */
const asTyped = (text: string) => text.replace(/\r\n?/g, '\n');

const wrapped = new WeakMap<ComponentType<FileRendererProps>, ComponentType<FileRendererProps>>();

/**
 * `Renderer`, saving in the file's own line endings.
 *
 * The built-in renderers edit in a `<textarea>`, which hands its text back
 * with LF endings whatever it was given (the HTML standard normalises its
 * value), so a CRLF file saved from one came back rewritten on every line.
 * While the renderer edits, it is handed its text the way its textarea holds
 * it, so its "unsaved" check compares like with like, and everything it hands
 * back (`onSave`, `onValueChange`) gets the endings of the saved text it was
 * given (`savedContent`, else `content`) put back ({@link restoreLineEndings}).
 * Read-only, it gets its props unchanged.
 *
 * One wrapper per renderer, so a host that looks its renderer up on every
 * render mounts the same component each time.
 */
export function withFileLineEndings(
  Renderer: ComponentType<FileRendererProps>,
): ComponentType<FileRendererProps> {
  const known = wrapped.get(Renderer);
  if (known) return known;
  function FileLineEndings(props: FileRendererProps) {
    if (props.readOnly) return <Renderer {...props} />;
    const { content, savedContent, onSave, onValueChange } = props;
    const original = savedContent ?? content;
    return (
      <Renderer
        {...props}
        content={asTyped(content)}
        savedContent={savedContent === undefined ? undefined : asTyped(savedContent)}
        onSave={(text) => onSave(restoreLineEndings(original, text))}
        onValueChange={onValueChange && ((text) => onValueChange(restoreLineEndings(original, text)))}
      />
    );
  }
  FileLineEndings.displayName = `FileLineEndings(${Renderer.displayName ?? Renderer.name})`;
  wrapped.set(Renderer, FileLineEndings);
  return FileLineEndings;
}
