import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { extractFrontmatter } from '@bevel-software/platform-shared';

/**
 * A friendly form over a `.tool` manual. THE TOOL IS THE FRONTMATTER: everything
 * — `id`/`name`, access verbs (`read`/`write`/`owner`/`download`), and the config
 * (`type`/`url`/`variables`/…) — lives in ONE `---` YAML block. The form edits
 * that one object and re-serializes it to `---\n<yaml>\n---\n`. Inline `tools[]`
 * are edited as raw JSON. `readOnly` disables every control so the same layout
 * renders for view-only files. The Code tab shows the raw file.
 */

type Obj = Record<string, unknown>;
type ToolType = 'inline' | 'http' | 'mcp';

const ACCESS_VERBS = ['read', 'write', 'owner', 'download'] as const;
const inputCls =
  'w-full rounded-md border border-line-strong px-2 py-1 text-xs focus:border-accent focus:outline-none disabled:bg-sunken disabled:text-ink-muted';

/**
 * Parse the tool object — the `---` fence's contents, or the whole file when
 * unfenced — plus the free-form notes after the closing fence (the parser
 * ignores them, but the form must CARRY them so an edit doesn't delete them).
 * `model` is null if unparseable.
 */
function parseFile(text: string): { model: Obj | null; notes: string } {
  const fm = extractFrontmatter(text);
  const notes = fm ? fm.body : '';
  const source = (fm ? fm.frontmatter : text).trim();
  if (!source) return { model: {}, notes };
  try {
    const p = parseYaml(source);
    return { model: p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : null, notes };
  } catch {
    return { model: null, notes };
  }
}

/**
 * Serialize the tool object into one `---` fenced YAML block (dropping empty
 * lists / blank strings), re-appending the file's free-form notes verbatim.
 */
function serializeFile(model: Obj, notes: string): string {
  const out: Obj = {};
  for (const [k, v] of Object.entries(model)) {
    if (v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return `---\n${stringifyYaml(out)}---\n${notes}`;
}

function normType(raw: unknown): ToolType {
  const t = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  return t === 'http' || t === 'mcp' ? t : 'inline';
}

export function ToolForm({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  const lastEmitted = useRef<string | null>(null);
  const [parsed, setParsed] = useState<{ model: Obj | null; notes: string }>(() => parseFile(value));

  useEffect(() => {
    if (value === lastEmitted.current) return;
    setParsed(parseFile(value));
  }, [value]);

  const { model, notes } = parsed;
  if (!model) {
    return (
      <p className="text-meta text-wait">
        This file isn’t valid JSON/YAML — switch to Code to {readOnly ? 'view' : 'fix'} it.
      </p>
    );
  }

  // The whole tool is one object; identity/access and config share it. Keep the
  // two setters as aliases so the field JSX below reads either concern uniformly.
  const set = (patch: Obj) => {
    if (readOnly) return;
    const next = { ...model, ...patch };
    setParsed({ model: next, notes });
    const text = serializeFile(next, notes);
    lastEmitted.current = text;
    onChange(text);
  };
  const frontmatter = model;
  const body = model;
  const setFm = set;
  const setBody = set;

  const type = normType(body.type);
  const remote = body.remote !== false;
  const headers = body.headers && typeof body.headers === 'object' ? (body.headers as Record<string, string>) : {};
  const variables = Array.isArray(body.variables) ? (body.variables as Obj[]) : [];

  return (
    <div className="space-y-3">
      <Field label="Id (the tool's stable name / secret namespace — lowercase snake_case)">
        <input
          className={inputCls}
          disabled={readOnly}
          value={typeof frontmatter.id === 'string' ? frontmatter.id : ''}
          onChange={(e) => setFm({ id: e.target.value })}
          placeholder="my_tool"
        />
      </Field>

      <Field label="Type">
        <select className={inputCls} disabled={readOnly} value={type} onChange={(e) => setBody({ type: e.target.value })}>
          <option value="inline">inline: tools embedded in this file</option>
          <option value="http">http: URL returning a UTCP manual</option>
          <option value="mcp">mcp: remote MCP server</option>
        </select>
      </Field>

      <label className="flex items-center gap-2 text-meta text-ink-muted">
        <input type="checkbox" disabled={readOnly} checked={remote} onChange={(e) => setBody({ remote: e.target.checked })} />
        Available to remote agents
        <span className="text-ink-faint">(uncheck for local-only tools, e.g. a localhost MCP server)</span>
      </label>

      {(type === 'http' || type === 'mcp') && (
        <Field label="URL">
          <input
            className={inputCls}
            disabled={readOnly}
            value={typeof body.url === 'string' ? body.url : ''}
            onChange={(e) => setBody({ url: e.target.value })}
            placeholder={type === 'mcp' ? 'https://mcp.example.com' : 'https://api.example.com/utcp'}
          />
        </Field>
      )}

      {type === 'http' && (
        <Field label="Method">
          <select
            className={inputCls}
            disabled={readOnly}
            value={body.httpMethod === 'POST' ? 'POST' : 'GET'}
            onChange={(e) => setBody({ httpMethod: e.target.value })}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
        </Field>
      )}

      {(type === 'http' || type === 'mcp') && (
        <KeyValueRows
          label="Headers"
          readOnly={readOnly}
          entries={Object.entries(headers)}
          placeholderKey="Authorization"
          placeholderVal="Bearer ${API_KEY}"
          onChange={(entries) => setBody({ headers: Object.fromEntries(entries.filter(([k]) => k)) })}
        />
      )}

      <VariableRows variables={variables} readOnly={readOnly} onChange={(v) => setBody({ variables: v })} />

      {type === 'inline' && (
        <InlineToolsEditor tools={body.tools} readOnly={readOnly} onChange={(tools) => setBody({ tools })} />
      )}

      <AccessSection frontmatter={frontmatter} readOnly={readOnly} onChange={setFm} />
    </div>
  );
}

/** Per-verb access lists (read/write/owner/download) — one principal per line. */
function AccessSection({ frontmatter, readOnly, onChange }: { frontmatter: Obj; readOnly: boolean; onChange: (patch: Obj) => void }) {
  const asLines = (v: unknown): string => (Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'string' ? String(v) : '');
  // Per-verb draft while a textarea is focused. A fully-controlled value of
  // `asLines(cleaned lines)` would swallow Enter: the newline is trimmed/
  // filtered out of the emitted lines, so the re-render erases it and a second
  // principal can never be started. The draft keeps what the user typed; the
  // CLEANED lines are still emitted on every keystroke, and blur re-syncs the
  // display to canonical form.
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  return (
    <div>
      <span className="mb-0.5 block text-meta font-medium text-ink-muted">
        Access <span className="font-normal text-ink-faint">(one role or `Name &lt;email&gt;` per line; prefix `deny ` to remove)</span>
      </span>
      <div className="grid grid-cols-2 gap-2">
        {ACCESS_VERBS.map((verb) => (
          <label key={verb} className="block">
            <span className="mb-0.5 block text-label uppercase text-ink-faint">{verb}</span>
            <textarea
              disabled={readOnly}
              rows={2}
              value={drafts[verb] ?? asLines(frontmatter[verb])}
              onChange={(e) => {
                const raw = e.target.value;
                setDrafts((d) => ({ ...d, [verb]: raw }));
                onChange({ [verb]: raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
              }}
              onBlur={() =>
                setDrafts((d) => {
                  const { [verb]: _done, ...rest } = d;
                  return rest;
                })
              }
              className="w-full resize-y rounded-md border border-line-strong px-1.5 py-1 text-meta focus:border-accent focus:outline-none disabled:bg-sunken disabled:text-ink-muted"
              placeholder={verb === 'read' ? 'everyone' : 'Role Name'}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-meta font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function KeyValueRows({
  label,
  entries,
  placeholderKey,
  placeholderVal,
  readOnly,
  onChange,
}: {
  label: string;
  entries: [string, string][];
  placeholderKey: string;
  placeholderVal: string;
  readOnly: boolean;
  onChange: (entries: [string, string][]) => void;
}) {
  const editAt = (i: number, next: [string, string]) => onChange(entries.map((e, j) => (j === i ? next : e)));
  return (
    <div>
      <span className="mb-0.5 block text-meta font-medium text-ink-muted">{label}</span>
      <div className="space-y-1">
        {entries.length === 0 && readOnly && <p className="text-meta text-ink-faint">None.</p>}
        {entries.map(([k, v], i) => (
          <div key={i} className="flex gap-1">
            <input
              className={inputCls}
              disabled={readOnly}
              value={k}
              placeholder={placeholderKey}
              onChange={(e) => editAt(i, [e.target.value, v])}
            />
            <input
              className={inputCls}
              disabled={readOnly}
              value={typeof v === 'string' ? v : ''}
              placeholder={placeholderVal}
              onChange={(e) => editAt(i, [k, e.target.value])}
            />
            {!readOnly && <RemoveButton onClick={() => onChange(entries.filter((_, j) => j !== i))} />}
          </div>
        ))}
        {!readOnly && <AddButton label="Add header" onClick={() => onChange([...entries, ['', '']])} />}
      </div>
    </div>
  );
}

function VariableRows({
  variables,
  readOnly,
  onChange,
}: {
  variables: Obj[];
  readOnly: boolean;
  onChange: (v: Obj[]) => void;
}) {
  const editAt = (i: number, patch: Obj) => onChange(variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div>
      <span className="mb-0.5 block text-meta font-medium text-ink-muted">
        Variables <span className="font-normal text-ink-faint">(who provisions each secret)</span>
      </span>
      <div className="space-y-1">
        {variables.length === 0 && readOnly && <p className="text-meta text-ink-faint">None.</p>}
        {variables.map((v, i) => (
          <div key={i} className="flex gap-1">
            <input
              className={inputCls}
              disabled={readOnly}
              value={typeof v.name === 'string' ? v.name : ''}
              placeholder="API_KEY"
              onChange={(e) => editAt(i, { name: e.target.value })}
            />
            <select
              className={inputCls}
              disabled={readOnly}
              value={v.scope === 'user' ? 'user' : 'admin'}
              onChange={(e) => editAt(i, { scope: e.target.value })}
            >
              <option value="admin">admin (shared)</option>
              <option value="user">user (per-user)</option>
            </select>
            <input
              className={inputCls}
              disabled={readOnly}
              value={typeof v.label === 'string' ? v.label : ''}
              placeholder="label (optional)"
              onChange={(e) => editAt(i, { label: e.target.value })}
            />
            {!readOnly && <RemoveButton onClick={() => onChange(variables.filter((_, j) => j !== i))} />}
          </div>
        ))}
        {!readOnly && (
          <AddButton label="Add variable" onClick={() => onChange([...variables, { name: '', scope: 'admin' }])} />
        )}
      </div>
    </div>
  );
}

/** Raw-JSON editor for inline `tools[]`; only propagates a valid parse (keeps local text otherwise). */
function InlineToolsEditor({
  tools,
  readOnly,
  onChange,
}: {
  tools: unknown;
  readOnly: boolean;
  onChange: (tools: unknown) => void;
}) {
  const external = JSON.stringify(Array.isArray(tools) ? tools : [], null, 2);
  const [text, setText] = useState(external);
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    if (external === lastEmitted.current) return;
    setText(external);
    setError(null);
  }, [external]);

  const onEdit = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
      setError(null);
      lastEmitted.current = JSON.stringify(parsed, null, 2);
      onChange(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'invalid JSON');
    }
  };

  return (
    <div>
      <span className="mb-0.5 block text-meta font-medium text-ink-muted">Inline tools (advanced, raw JSON)</span>
      <textarea
        value={readOnly ? external : text}
        readOnly={readOnly}
        onChange={(e) => onEdit(e.target.value)}
        spellCheck={false}
        rows={8}
        className="w-full resize-y rounded-md border border-line-strong bg-sunken p-2 font-mono text-meta focus:border-accent focus:outline-none"
      />
      {!readOnly && error && <p className="mt-0.5 text-micro text-danger">Inline tools: {error}</p>}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-ink-muted hover:bg-hover"
    >
      <Plus size={11} /> {label}
    </button>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm p-1 text-ink-faint hover:bg-danger-soft hover:text-danger"
      aria-label="Remove"
    >
      <X size={12} />
    </button>
  );
}
