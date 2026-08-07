import { useCallback, useEffect, useRef, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import { extractFrontmatter } from '@bevel-software/platform-shared';
import type { FileRendererProps, RendererSaveState } from './types';
import { authFetch } from '../../../../lib/api';
import { Markdown } from '../../../../shared/markdown/Markdown';
import { ToolForm } from './ToolForm';
import { ToolSecretsPanel } from '../../../secrets-vault/components/ToolSecretsPanel';
import { listToolSecrets, type ToolSecrets } from '../../../secrets-vault/services/tool-secrets.api';

/**
 * Whether the Form view can render this file: THE TOOL IS THE FRONTMATTER, so
 * a fenced file's `---` block must parse to an object (anything after the
 * closing fence is free-form notes the Form shows below the fields); a
 * fence-less legacy file is the object itself.
 */
function parsesToObject(text: string): boolean {
  if (!text.trim()) return true; // empty file → start in Form
  const fm = extractFrontmatter(text);
  const source = (fm ? fm.frontmatter : text).trim();
  if (!source) return true;
  try {
    const p = parseYaml(source);
    return !!p && typeof p === 'object' && !Array.isArray(p);
  } catch {
    return false;
  }
}

/** The free-form notes after the closing `---` fence (empty for fence-less files). */
function notesOf(text: string): string {
  return extractFrontmatter(text)?.body.trim() ?? '';
}

/**
 * Config UI for a `.tool` file — a UTCP manual (inline / http / mcp) that the
 * MCP/UTCP endpoint loads for anyone who can read it. The file's JSON is the
 * source of truth (edited in the pane), with helpers alongside: scaffolds for
 * each manual type, a palette of Secrets Vault keys that inserts `${KEY}` at the
 * cursor, and a live Preview that resolves/validates the manual's tools.
 *
 * Save/dirty plumbing mirrors the other text-backed renderers; the parent
 * (`FileViewer`) owns the commit/push.
 */

interface PreviewResult {
  ok: boolean;
  tools?: { name: string; description?: string }[];
  errors?: string[];
}

// THE TOOL IS THE FRONTMATTER: id + access + config all live in ONE `---` YAML
// block. The id is the tool's stable name / secret namespace (snake_case).
const SCAFFOLDS: Record<string, string> = {
  inline: [
    '---',
    'id: my_tool',
    'type: inline',
    'tools:',
    '  - name: example',
    '    description: What this tool does.',
    '    inputs: { type: object, properties: {} }',
    '    outputs: { type: object, properties: {} }',
    '    tool_call_template:',
    '      call_template_type: http',
    '      http_method: POST',
    '      url: https://api.example.com/do',
    '      headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" }',
    '---',
    '',
  ].join('\n'),
  http: [
    '---',
    'id: my_tool',
    'type: http',
    'remote: true',
    'url: https://api.example.com/utcp',
    'headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" }',
    '---',
    '',
  ].join('\n'),
  mcp: [
    '---',
    'id: my_tool',
    'type: mcp',
    'remote: true',
    'url: https://mcp.example.com',
    'headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" }',
    '---',
    '',
  ].join('\n'),
};

export function ToolRenderer({
  content,
  savedContent,
  filePath,
  onSave,
  onDirtyChange,
  onValueChange,
  onSaveStateChange,
  readOnly = false,
}: FileRendererProps) {
  const [value, setValue] = useState(content);
  const [savedValue, setSavedValue] = useState(savedContent ?? content);
  const [saveState, setSaveState] = useState<RendererSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [toolSecrets, setToolSecrets] = useState<ToolSecrets | null>(null);
  const [mode, setMode] = useState<'form' | 'code'>(() => (parsesToObject(content) ? 'form' : 'code'));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const savingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Monotonic id so a slow `loadToolSecrets` can't apply a result for a prior file.
  const toolSecretsReqRef = useRef(0);

  const dirty = !readOnly && value !== savedValue;

  useEffect(() => {
    setValue(content);
    setSavedValue(savedContent ?? content);
    setSaveState('idle');
    setSaveError(null);
    setPreview(null);
  }, [content, savedContent, filePath]);

  // Re-pick the default view (Form when parseable, else Code) when the file changes.
  useEffect(() => {
    setMode(parsesToObject(content) ? 'form' : 'code');
    // Only on file switch — not on every keystroke, or Code edits would flip to Form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);

  // Load the caller's Secrets Vault keys for the insert palette.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/secrets');
        if (!res.ok) return;
        const body = (await res.json()) as { secrets?: { key: string }[] };
        if (!cancelled) setSecretKeys((body.secrets ?? []).map((s) => s.key));
      } catch {
        /* palette is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load THIS tool's declared variables + their config status (for the per-tool
  // secrets panel). Matched from the default-branch catalog by file path (with a
  // basename fallback, since the editor's path may be prefixed differently).
  const loadToolSecrets = useCallback(async () => {
    // Guard against a stale response landing after `filePath` changed: only the
    // newest request may call setToolSecrets.
    const reqId = ++toolSecretsReqRef.current;
    try {
      const tools = await listToolSecrets();
      if (reqId !== toolSecretsReqRef.current) return;
      const base = filePath.split('/').pop();
      // Prefer the strongest match so an exact path never loses to a weaker suffix
      // / basename match (which could expose a different tool's secrets).
      const match =
        tools.find((t) => t.path === filePath) ??
        tools.find((t) => t.path.endsWith(filePath) || filePath.endsWith(t.path)) ??
        tools.find((t) => t.path.split('/').pop() === base) ??
        null;
      setToolSecrets(match);
    } catch {
      if (reqId === toolSecretsReqRef.current) setToolSecrets(null);
    }
  }, [filePath]);

  useEffect(() => {
    void loadToolSecrets();
  }, [loadToolSecrets]);

  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly || value === savedValue) return true;
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    try {
      await onSave(value);
      setSavedValue(value);
      setSaveState('idle');
      return true;
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [readOnly, value, savedValue, onSave]);

  const updateValue = useCallback(
    (next: string) => {
      setValue(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const insertAtCursor = useCallback(
    (text: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? value.length;
      const next = value.slice(0, start) + text + value.slice(end);
      updateValue(next);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + text.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [value, updateValue],
  );

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const res = await authFetch('/api/tools/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value }),
      });
      if (!res.ok) {
        // A 401/500 body isn't a PreviewResult — surface it as an error rather
        // than letting it fall through to the "No tools." branch.
        const msg = await res
          .json()
          .then((b) => (b as { error?: string })?.error)
          .catch(() => null);
        setPreview({ ok: false, errors: [msg || `Preview failed (HTTP ${res.status})`] });
        return;
      }
      setPreview((await res.json()) as PreviewResult);
    } catch (err) {
      setPreview({ ok: false, errors: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setPreviewing(false);
    }
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    },
    [save],
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 flex-1 flex-col border-r border-line">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="text-xs font-medium text-ink-muted">{filePath.split('/').pop()}</span>
          {dirty && <span className="text-micro text-wait">● unsaved</span>}
          {saveState === 'error' && <span className="text-micro text-danger">{saveError}</span>}
          {/* No Save button here — like the other renderers, the FileViewer's Save
              persists edits (tracked via onValueChange). We only own the view toggle. */}
          <div className="ml-auto flex overflow-hidden rounded-xs border border-line">
            {(['form', 'code'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 text-meta capitalize ${
                  mode === m ? 'bg-ink text-white' : 'bg-white text-ink-muted hover:bg-hover'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {mode === 'form' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <ToolForm value={value} onChange={updateValue} readOnly={readOnly} />
            {notesOf(value) && (
              <section className="mt-4 border-t border-line pt-3">
                <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-ink-faint">Notes</h3>
                {/* The free-form markdown after the frontmatter fence — where a
                    tool's setup instructions live. Edited in the Code view. */}
                <Markdown className="text-xs">{notesOf(value)}</Markdown>
              </section>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            readOnly={readOnly}
            onChange={(e) => updateValue(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-sunken p-3 font-mono text-xs text-ink focus:outline-none"
            placeholder="A .tool file is a UTCP manual. Use a scaffold →"
          />
        )}
      </div>

      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto p-3">
        {!readOnly && (
          <section>
            <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-ink-faint">Scaffold</h3>
            <div className="flex gap-1">
              {(['inline', 'http', 'mcp'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    if (!value.trim() || window.confirm('Replace the file contents with this scaffold?')) {
                      updateValue(SCAFFOLDS[t]);
                    }
                  }}
                  className="rounded-xs bg-sunken px-2 py-1 text-meta text-ink-muted hover:bg-hover"
                >
                  {t}
                </button>
              ))}
            </div>
          </section>
        )}

        {!readOnly && (
          <section>
            <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-ink-faint">Secret variables</h3>
            {secretKeys.length === 0 ? (
              <p className="text-meta text-ink-faint">
                No secrets yet. Add them on the Secrets page, then reference them here.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {secretKeys.map((k) => (
                  <button
                    key={k}
                    onClick={() => insertAtCursor(`\${${k}}`)}
                    className="rounded-xs bg-accent/10 px-1.5 py-0.5 font-mono text-micro text-accent hover:bg-accent/15"
                    title={`Insert \${${k}}`}
                  >
                    {`\${${k}}`}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <section>
          <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-ink-faint">Secrets for this tool</h3>
          {toolSecrets ? (
            <ToolSecretsPanel tool={toolSecrets} onChanged={() => void loadToolSecrets()} />
          ) : (
            <p className="text-meta text-ink-faint">
              Declare a <code className="rounded-xs bg-sunken px-1">variables</code> block and save this tool to the
              default branch to configure its secrets here.
            </p>
          )}
        </section>

        <section>
          <div className="mb-1 flex items-center gap-2">
            <h3 className="text-meta font-semibold uppercase tracking-wide text-ink-faint">Preview</h3>
            <button
              onClick={() => void runPreview()}
              disabled={previewing}
              className="ml-auto rounded-xs bg-sunken px-2 py-0.5 text-meta text-ink-muted hover:bg-hover disabled:opacity-40"
            >
              {previewing ? '…' : 'Run'}
            </button>
          </div>
          {preview && (
            <div className="text-meta">
              {preview.errors?.length ? (
                <ul className="space-y-1 text-danger">
                  {preview.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : preview.tools && preview.tools.length > 0 ? (
                <ul className="space-y-1">
                  {preview.tools.map((t) => (
                    <li key={t.name} className="rounded-xs bg-sunken px-1.5 py-1">
                      <code className="text-ink">{t.name}</code>
                      {t.description && <div className="text-ink-faint">{t.description}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-faint">
                  {preview.ok ? 'Valid. Tools resolve at runtime (http/mcp).' : 'No tools.'}
                </p>
              )}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
