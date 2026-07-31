import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * Text inputs. Implements the prototype's `.msearch` and `.sbnote`.
 *
 * Covers 47 form fields (37 <input>, 16 <textarea> minus overlaps). The
 * important part is the focus treatment: the 15 hand-rolled fields recolour
 * their border on focus, which is on-system but still repaints a 1px edge.
 * This uses an inset outline plus a transparent border instead, so the
 * control does not shift by a pixel when focused.
 *
 * Both components spread `...rest`, so `aria-label`, `aria-describedby`,
 * `required` and validation attributes stay entirely the caller's.
 */

const BASE = cn(
  'w-full border border-line-strong bg-surface text-ink',
  'placeholder:text-ink-faint',
  'focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-accent',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {}

export function TextField({ className, type = 'text', ...rest }: TextFieldProps) {
  return (
    <input
      type={type}
      className={cn(BASE, 'rounded-md px-2.5 py-2 text-ui', className)}
      {...rest}
    />
  );
}

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function TextAreaField({ className, ...rest }: TextAreaFieldProps) {
  return (
    <textarea
      className={cn(BASE, 'min-h-16 resize-y rounded-md px-3 py-2.5 text-body', className)}
      {...rest}
    />
  );
}
