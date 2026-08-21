import { useEffect, useState } from 'react';
import { Mail, Paperclip } from 'lucide-react';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import { DownloadFileButton } from './DownloadFileButton';
import { MAX_EMAIL_BYTES, attachmentLine, type EmailMessageView } from './emailMessage';
import type { FileRendererProps } from './types';

/**
 * The honest email view for `.eml` and `.msg`: labelled header fields, the
 * body as PLAIN TEXT, attachments listed by name — the same story the
 * backend's extractors tell agents through `read_file`, so human and agent
 * conversations about one message point at the same thing.
 *
 * Nothing from the message is ever interpreted as HTML: an HTML-only body is
 * stripped to text by the parser and rendered as React text nodes, and the
 * up-front note says formatting is omitted. Attachments are names, not
 * downloads — v1 does not unpack them; the original file (with everything in
 * it) is one Download away.
 *
 * Parsing is client-side, per format, behind its own dynamic import so the
 * `.eml` path never pays for the CFB machinery: postal-mime for `.eml`
 * (`emlMessage.ts`), SheetJS CFB for `.msg` (`msgMessage.ts` — msgreader
 * itself does not load in a browser; see there).
 *
 * View-only: there is no edit mode for a message snapshot. The renderer
 * ignores `onSave` / `onValueChange` / `readOnly`.
 */
export function EmailRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
  const [view, setView] = useState<EmailMessageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    if (!workspaceId) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load email (HTTP ${res.status})`);
          return;
        }
        // The size bound belongs BEFORE the buffer, not after it: the parsers
        // check the limit once they hold the bytes, by which point a 300 MB
        // message has already been allocated in the tab.
        const declared = Number(res.headers?.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_EMAIL_BYTES) {
          setError('This email is too large to display.');
          return;
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        const parsed = filePath.toLowerCase().endsWith('.msg')
          ? (await import('./msgMessage')).parseMsgMessage(buffer)
          : await (await import('./emlMessage')).parseEmlMessage(buffer);
        if (cancelled) return;
        setView(parsed);
      } catch (e) {
        if (cancelled) return;
        // The parsers throw "could not be parsed as a .eml/.msg (…)".
        setError(`This file ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath]);

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-ui text-danger">{error}</p>
        <DownloadFileButton filePath={filePath} />
      </div>
    );
  }

  if (view === null) {
    return (
      <div className="flex min-h-40 items-center justify-center text-ui text-ink-muted">
        Loading email…
      </div>
    );
  }

  const headerFields: Array<[string, string]> = [];
  if (view.from !== undefined) headerFields.push(['From', view.from]);
  if (view.to !== undefined) headerFields.push(['To', view.to]);
  if (view.cc !== undefined) headerFields.push(['Cc', view.cc]);
  if (view.bcc !== undefined) headerFields.push(['Bcc', view.bcc]);
  if (view.subject !== undefined) headerFields.push(['Subject', view.subject]);
  if (view.date !== undefined) headerFields.push(['Date', view.date]);

  return (
    // A document, not a viewport: sits in `KbDocumentShell`'s prose column.
    <div className="min-w-0">
      {/* What this view is, and the way to the real thing — up front: text
          only, formatting omitted, attachments listed but not unpacked. */}
      <div className="mb-4 flex items-center gap-3 rounded-sm bg-sunken px-3 py-2">
        <Mail size={15} className="shrink-0 text-ink-faint" aria-hidden />
        <p className="min-w-0 flex-1 text-detail text-ink-muted">
          Text view of the email — formatting, inline images and attachment contents are not
          shown. Download the file to open it in a mail client.
        </p>
        <DownloadFileButton filePath={filePath} size="sm" />
      </div>

      {headerFields.length > 0 && (
        <dl className="mb-4 border-b border-line pb-3">
          {headerFields.map(([label, value]) => (
            <div key={label} className="mb-1 flex gap-2">
              <dt className="w-16 shrink-0 text-detail font-medium text-ink-faint">{label}</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ui text-ink">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {view.bodySource === 'rtf-only' ? (
        <p className="text-detail italic text-ink-faint">
          The message body is stored as RTF only — there is no plain-text part to show. Download
          the file to read it in a mail client.
        </p>
      ) : view.body === '' ? (
        <p className="text-detail italic text-ink-faint">No message body.</p>
      ) : (
        <div className="whitespace-pre-wrap break-words text-ui text-ink">{view.body}</div>
      )}

      {view.attachments.length > 0 && (
        <div className="mt-6 border-t border-line pt-3">
          <div className="mb-1 flex items-center gap-1.5 text-meta font-medium uppercase tracking-wide text-ink-faint">
            <Paperclip size={12} aria-hidden />
            Attachments
          </div>
          <ul>
            {view.attachments.map((a, i) => (
              <li key={i} className="mb-0.5 text-detail text-ink-muted">
                {attachmentLine(a)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-meta text-ink-faint">
            Attachments are listed by name only — download the email to get them.
          </p>
        </div>
      )}
    </div>
  );
}
