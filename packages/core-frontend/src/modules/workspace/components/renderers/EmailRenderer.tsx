import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Mail, Paperclip } from 'lucide-react';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import { copyToClipboard } from '../../../../lib/clipboard';
import { DownloadFileButton } from './DownloadFileButton';
import { MAX_EMAIL_BYTES, attachmentLine, type EmailMessageView } from './emailMessage';
import { buildEmailBody, type EmailLink } from './emailBody';
import { readBodyCapped } from './readBodyCapped';
import type { FileRendererProps } from './types';

/**
 * The honest email view for `.eml` and `.msg`: labelled header fields, the
 * body as PLAIN TEXT, attachments listed by name — the same story the
 * backend's extractors tell agents through `read_file`, so human and agent
 * conversations about one message point at the same thing.
 *
 * A message that carries HTML is RENDERED, the way a mail client renders it —
 * inside a frame mounted `sandbox=""` (no scripts, ever) whose policy permits
 * `img-src data:` and nothing else. Two consequences are the point of the
 * design: no script in a stranger's mail can run, and no remote fetch can
 * happen, so a tracking pixel cannot report that this message was opened.
 * Images the sender EMBEDDED still appear — they travel inside the file, and
 * are inlined as data: URIs. Links are made inert and listed below the body
 * with their full address, because a click inside a script-free frame cannot
 * be intercepted and a live anchor would open its destination unseen.
 *
 * A message with no HTML part falls back to the plain text, as before.
 * Attachments are names, not downloads — v1 does not unpack them; the original
 * file (with everything in it) is one Download away.
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
  // The sender's own markup, made safe to show. Rebuilt only when the message
  // changes — the sanitize + inline pass walks the whole body.
  const rendered = useMemo(
    () => (view?.bodyHtml !== undefined ? buildEmailBody(view.bodyHtml, view.attachments) : null),
    [view],
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    if (!workspaceId) return;

    let cancelled = false;
    // Cleanup ABORTS, not just flags: flipping `cancelled` alone would let an
    // abandoned view keep downloading and buffering the whole message.
    const controller = new AbortController();
    (async () => {
      try {
        const res = await authFetch(
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
          { signal: controller.signal },
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load email (HTTP ${res.status})`);
          return;
        }
        // The size bound belongs BEFORE the buffer, not after it: the parsers
        // check the limit once they hold the bytes, by which point a 300 MB
        // message has already been allocated in the tab. `readBodyCapped`
        // refuses an over-cap Content-Length without reading a byte (and ends
        // the transfer) and abandons an undeclared body the moment it crosses
        // the cap.
        const buffer = await readBodyCapped(res, MAX_EMAIL_BYTES, controller);
        if (cancelled) return;
        if (buffer === null) {
          setError('This email is too large to display.');
          return;
        }
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
      controller.abort();
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
          {rendered !== null
            ? 'The sender’s formatting, shown without remote content: images hosted elsewhere are not loaded, and links open only after you confirm the address. Attachment contents are not shown.'
            : 'Text view of the email — formatting, inline images and attachment contents are not shown.'}{' '}
          Download the file to open it in a mail client.
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
      ) : rendered !== null ? (
        <>
          <iframe
            // `sandbox=""` — NOT allow-scripts. Nothing in a stranger's message
            // executes, and the document's CSP allows `img-src data:` only, so no
            // remote fetch can happen: a tracking pixel cannot report that this
            // message was opened. Images the sender EMBEDDED are inlined as data:
            // URIs and do render.
            sandbox=""
            srcDoc={rendered.srcDoc}
            title="Message body"
            className="h-[32rem] w-full rounded-xs border border-line bg-white"
          />
          {(rendered.blockedRemoteImages > 0 || rendered.unavailableInlineImages > 0) && (
            <p className="mt-2 text-detail text-ink-faint">
              {rendered.blockedRemoteImages > 0 && (
                <>
                  {rendered.blockedRemoteImages} remote image
                  {rendered.blockedRemoteImages === 1 ? '' : 's'} not loaded — fetching one would
                  tell the sender you opened this message.
                </>
              )}
              {rendered.blockedRemoteImages > 0 && rendered.unavailableInlineImages > 0 && ' '}
              {rendered.unavailableInlineImages > 0 && (
                <>
                  {rendered.unavailableInlineImages} embedded image
                  {rendered.unavailableInlineImages === 1 ? '' : 's'} could not be shown — the part
                  is missing from the file or too large to inline.
                </>
              )}
            </p>
          )}
          {rendered.links.length > 0 && <EmailLinks links={rendered.links} />}
        </>
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


/**
 * A copy button that says whether the copy LANDED.
 *
 * `navigator.clipboard` is absent outside a secure context and rejects when
 * the document is not focused — ordinary conditions, not exceptions. A button
 * that silently did nothing (or left an unhandled rejection) would leave the
 * reader believing they hold an address they do not.
 */
function CopyLinkButton({ url }: { url: string }): React.ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 text-ink-faint hover:text-ink"
      title={state === 'failed' ? 'Could not copy — select the address instead' : 'Copy this address'}
      onClick={() => {
        void copyToClipboard(url).then((ok) => {
          setState(ok ? 'copied' : 'failed');
          window.setTimeout(() => setState('idle'), 2000);
        });
      }}
    >
      {state === 'copied' ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {state !== 'idle' && (
        <span className="text-meta">{state === 'copied' ? 'Copied' : 'Copy failed'}</span>
      )}
    </button>
  );
}

/**
 * The message's links, in TRUSTED UI outside the sandbox.
 *
 * A click inside a script-free frame cannot be intercepted, so an anchor left
 * live would open its destination with no chance to show the reader where it
 * goes. The body renders them inert and numbered instead, and they are listed
 * here with the whole address visible: copy it, or open it deliberately. A
 * phishing link is never one stray click away, and nothing in the frame can
 * reach `window.opener` or leak a referrer, because nothing in the frame
 * navigates at all.
 */
function EmailLinks({ links }: { links: readonly EmailLink[] }): React.ReactElement {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-1 flex items-center gap-1.5 text-meta font-medium uppercase tracking-wide text-ink-faint">
        <ExternalLink size={12} aria-hidden />
        Links
      </div>
      <ul className="space-y-1">
        {links.map((link) => (
          <li key={link.index} className="flex items-start gap-2 text-detail">
            <span className="shrink-0 text-ink-faint">[{link.index}]</span>
            <span className="min-w-0 flex-1">
              {link.text !== '' && <span className="text-ink">{link.text} — </span>}
              <span className="break-all text-ink-faint">{link.url}</span>
            </span>
            <CopyLinkButton url={link.url} />
            <button
              type="button"
              className="shrink-0 text-ink-faint hover:text-ink"
              title="Open in a new tab"
              onClick={() => {
                // Asked before anything opens, with the address in the prompt:
                // the reader decides against the REAL destination, not against
                // whatever text the sender chose to show.
                if (window.confirm(`Open this link?

${link.url}`)) {
                  window.open(link.url, '_blank', 'noopener,noreferrer');
                }
              }}
            >
              <ExternalLink size={12} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}