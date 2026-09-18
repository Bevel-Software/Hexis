#!/usr/bin/env node
/**
 * The scripted table behind "a missing file answers 404 on every file tool".
 *
 * Calls every file tool against a path that is not there and prints what each
 * one answers, as a markdown table. The run goes through `call_tool_chain`,
 * NEVER through a direct tool call: the direct surface formats a tool's error
 * and drops its status, so a tool answering 500 looks identical to one
 * answering 404 from the outside. Inside a chain the thrown error carries the
 * transport's status, which is the only thing this table is about.
 *
 * Usage:
 *   node scripts/missing-path-map.mjs --url http://app:3001 --token <bearer> \
 *     --branch <draft-branch> [--under <readable-folder>] [--json]
 *
 * `--token` is any bearer the MCP endpoint accepts: a connection key
 * (`bevel_…`), an MCP OAuth token, or a plain login JWT. `--branch` must be a
 * DRAFT branch — on a protected branch the write tools refuse before they ever
 * look at the path, which is a different answer than the one being mapped.
 *
 * Exit code 0 when every tool answered 404 `not_found`, 1 otherwise, so the
 * same script is both the "what does it do today" map and the regression check.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const url = flag('url', 'http://app:3001').replace(/\/+$/, '');
const token = flag('token', process.env.HEXIS_TOKEN);
const branch = flag('branch', 'main');
// The folder the missing paths are named under. It must be one the caller can
// READ: the read gate answers BEFORE absence does — that is what keeps a
// missing path from disclosing existence — so a row under an unreadable folder
// would be a 403 by design and does not belong in this table. The repository
// root is the safe default: an admin always keeps access there.
const under = flag('under', 'knowledge-base').replace(/\/+$/, '');
const asJson = args.includes('--json');
if (!token) {
  console.error('missing --token (or HEXIS_TOKEN)');
  process.exit(2);
}

/** One JSON-RPC call against the MCP endpoint, parsed out of its SSE frame. */
async function mcp(method, params) {
  const res = await fetch(`${url}/api/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok && !text.includes('"result"')) {
    throw new Error(`HTTP ${res.status} from /api/mcp: ${text.slice(0, 400)}`);
  }
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  const body = JSON.parse(line.replace(/^data: /, ''));
  if (body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Run one `call_tool_chain` program and return its parsed payload. */
async function chain(code) {
  const result = await mcp('tools/call', { name: 'call_tool_chain', arguments: { code, timeout: 120000 } });
  const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: text };
  }
}

// The chain body. Every call is wrapped so one tool's answer never ends the
// table, and only the things the ticket asks about are kept: the HTTP status,
// the `kind`, the echoed path, and the message.
const PROGRAM = (branchName, folder) => `
const branch = ${JSON.stringify(branchName)};
const folder = ${JSON.stringify(folder)};
const sessionId = KNOWLEDGE_BASE.start_session({ body: {} }).sessionId;
const MISSING = folder + '/__no_such_file__.md';
const MISSING_ZIP = folder + '/__no_such_archive__.zip';
const DEST = folder + '/__no_such_destination__.md';
const rows = [];
function probe(label, fn) {
  try {
    rows.push({ tool: label, status: 200, answer: JSON.stringify(fn()).slice(0, 200) });
  } catch (err) {
    // The chain's transport puts the tool's HTTP status at the front of the
    // message ("HTTP 500 calling tool '…': …"). That prefix IS what this table
    // exists to read, and it is exactly what a direct call throws away.
    const m = /^HTTP ([0-9]{3})/.exec(String(err.message));
    let data = err.data;
    if (!data) {
      const j = /Error data: (\\{[\\s\\S]*\\})\\s*$/.exec(String(err.message));
      if (j) { try { data = JSON.parse(j[1]); } catch (_ignored) { data = undefined; } }
    }
    rows.push({
      tool: label,
      status: typeof err.status === 'number' ? err.status : m ? Number(m[1]) : null,
      answer: String(err.message).replace(/ Error data: [\\s\\S]*$/, '').slice(0, 300),
      kind: data && data.kind ? data.kind : null,
      path: data && data.path ? data.path : null,
    });
  }
}
probe('read_file', () => KNOWLEDGE_BASE.read_file({ body: { branch, path: MISSING, sessionId } }));
probe('file_stat', () => KNOWLEDGE_BASE.file_stat({ body: { branch, path: MISSING, sessionId } }));
probe('grep (named path)', () => KNOWLEDGE_BASE.grep({ body: { branch, pattern: 'anything', path: MISSING, sessionId } }));
probe('edit_file', () => KNOWLEDGE_BASE.edit_file({ body: { branch, path: MISSING, old_string: 'a', new_string: 'b', sessionId } }));
probe('delete_file', () => KNOWLEDGE_BASE.delete_file({ body: { branch, path: MISSING, sessionId } }));
probe('move_file', () => KNOWLEDGE_BASE.move_file({ body: { branch, src: MISSING, dest: DEST, sessionId } }));
probe('copy_file', () => KNOWLEDGE_BASE.copy_file({ body: { branch, src: MISSING, dest: DEST, sessionId } }));
probe('unzip', () => KNOWLEDGE_BASE.unzip({ body: { branch, path: MISSING_ZIP, sessionId } }));
return rows;
`;

const payload = await chain(PROGRAM(branch, under));
if (!payload.success) {
  console.error('chain failed:', payload.error ?? payload);
  process.exit(1);
}
const rows = payload.result;
if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const cell = (v) => (v ? '`' + v + '`' : '—');
  console.log('| tool | status | kind | path | answer |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(
      `| ${cell(r.tool)} | ${r.status ?? '—'} | ${cell(r.kind)} | ${cell(r.path)} | ${String(r.answer).replace(/\|/g, '\\|')} |`,
    );
  }
}
const bad = rows.filter((r) => r.status !== 404 || r.kind !== 'not_found');
console.log(`\n${rows.length - bad.length}/${rows.length} answer 404 not_found.`);
process.exit(bad.length === 0 ? 0 : 1);
