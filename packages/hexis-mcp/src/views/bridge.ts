/**
 * The bridge a knowledge view runs on when an MCP host shows it.
 *
 * An html-knowledge-view page is written for one host, the Bevel app, which
 * gives it `window.bevel.buildGraph()` for live data. This script gives the
 * page the same entry point inside any MCP Apps host (Claude, ChatGPT, VS Code)
 * and speaks the MCP Apps protocol for it (JSON-RPC over `postMessage`,
 * protocol 2026-01-26):
 *
 * - `buildGraph()` resolves with the live snapshot the view's tool call
 *   returned (in the result's `_meta`), or asks the server for one through the
 *   host when no such result arrives;
 * - a clicked knowledge-base link opens that file in the Hexis web app;
 * - text the page puts on the clipboard (the kit's "copy your changes for
 *   Claude" flow) is sent to the chat as a user message instead, when the host
 *   accepts messages, which is the whole point of copying it;
 * - the page reports its height, and offers fullscreen when the host has it.
 *
 * It is injected as the FIRST script in the page, so it is in place before the
 * kit decides whether a bridge exists.
 */

import { HTML_NAV_BRIDGE } from '@bevel-software/platform-shared';
import { nativeMarkup } from './native.js';

export interface BridgeConfig {
  /** The view's tool, passed back to the data tool when the bridge asks for live data. */
  view: string;
  /** The app-only tool that returns a view's live snapshot. */
  dataTool: string;
  /** The app-only tool that turns a link the page follows into the address to open (the app's grammar). */
  linkTool: string;
  /** Repo path of the page, e.g. `KnowledgeBase/.../To-Do-List.html`. */
  pagePath: string;
  branch: string;
  /** The repository's folder, the first segment of an app path (`<kbDir>/<pagePath>`). */
  kbDir: string;
}

/** The view-side `_meta` key a view tool's result carries its live snapshot under. */
export const VIEW_META_KEY = 'hexis/view';

// Plain ES2019 in a string: it runs in the host's sandboxed iframe, untranspiled.
const BRIDGE_SOURCE = String.raw`
(() => {
  const CFG = __HEXIS_BRIDGE_CONFIG__;
  const PROTOCOL = '2026-01-26';
  const META = '${VIEW_META_KEY}';
  const host = window.parent;
  let nextId = 1;
  const pending = new Map();
  let hostCaps = {};
  let hostContext = {};
  let initialized = false;

  const send = (msg) => host.postMessage(msg, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params: params || {} });

  // Events for the compact presentation (native.ts): 'snapshot', 'live-error', 'context'.
  const listeners = {};
  const on = (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); };
  const emit = (event, arg) => {
    for (const fn of listeners[event] || []) { try { fn(arg); } catch (e) { console.error(e); } }
  };

  // -- live data -------------------------------------------------------------
  let settle;
  const snapshotReady = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let settled = false;
  const deliver = (snapshot, error) => {
    if (settled) return;
    settled = true;
    if (snapshot) {
      settle.resolve(snapshot);
      emit('snapshot', snapshot);
    } else {
      settle.reject(new Error(error || 'no live data'));
      emit('live-error', error || 'no live data');
    }
  };
  snapshotReady.catch(() => { /* the kit (or nobody) awaits it; the event already said so */ });
  const snapshotOf = (result) => {
    if (!result) return null;
    const meta = result._meta && result._meta[META];
    if (meta && meta.snapshot) return meta.snapshot;
    const sc = result.structuredContent;
    return sc && sc.snapshot ? sc.snapshot : null;
  };
  const errorOf = (result) => {
    const meta = result && result._meta && result._meta[META];
    if (meta && meta.liveError) return meta.liveError;
    const text = result && Array.isArray(result.content) ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ') : '';
    return result && result.isError ? (text || 'the server could not load live data') : null;
  };
  // How long a host that does not advertise serverTools gets to answer before the view says why it has no data.
  const UNADVERTISED_CALL_MS = 15000;
  const within = (promise, ms, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  // A call to the server, through the host. Tried even when the host does not
  // advertise serverTools: hosts that proxy calls do not all say so. One that
  // neither says so nor answers is given up on, so the view says why instead
  // of waiting forever.
  const callServer = (name, args, what) => {
    const call = request('tools/call', { name, arguments: args });
    return hostCaps.serverTools ? call : within(call, UNADVERTISED_CALL_MS, 'the host did not answer the request for ' + what);
  };
  async function fetchLive() {
    try {
      const result = await callServer(CFG.dataTool, { view: CFG.view, branch: CFG.branch }, 'live data');
      const snap = snapshotOf(result);
      deliver(snap, snap ? null : errorOf(result));
    } catch (e) {
      deliver(null, e && e.message ? e.message : String(e));
    }
  }

  // The kit's makeGraph (KV-KIT 1.1.0): the graph shape window.bevel.buildGraph() returns in the app.
  const toLink = (l) => ({ text: l.text, relativePath: l.path, resolvedPath: l.path });
  function rehydrateField(f) {
    const children = new Map();
    if (f && f.children) for (const k of Object.keys(f.children)) children.set(k, rehydrateField(f.children[k]));
    return { text: (f && f.text) || '', links: ((f && f.links) || []).map(toLink),
      sourceOfInformation: (f && f.sourceOfInformation) || null, children };
  }
  function makeNode(path, n) {
    const fields = new Map();
    if (n.fields) for (const k of Object.keys(n.fields)) fields.set(k, rehydrateField(n.fields[k]));
    const links = new Map();
    if (n.links) for (const cat of Object.keys(n.links)) links.set(cat, n.links[cat].map(toLink));
    return {
      filePath: n.file_path || path, nodeType: n.node_type, id: n.id == null ? null : n.id,
      owner: n.owner == null ? null : n.owner, fields, links,
      get name() {
        const f = fields.get('Name') || fields.get('Title') || fields.get('name') || fields.get('title');
        return f ? f.text : '';
      },
      getLinks: (cat) => links.get(cat) || [],
    };
  }
  function makeGraph(data) {
    const nodes = new Map();
    const nd = (data && data.nodes) || {};
    for (const p of Object.keys(nd)) nodes.set(p, makeNode(p, nd[p]));
    const edges = ((data && data.edges) || []).map((e) => (
      { sourcePath: e.source, targetPath: e.target, label: e.label, category: e.category }));
    const graph = {
      nodes, edges,
      get: (p) => nodes.get(p),
      nodesByType(t) { const out = new Map(); for (const [k, v] of nodes) if (v.nodeType === t) out.set(k, v); return out; },
      get processes() { return graph.nodesByType('Process'); },
      neighbors(filePath, direction = 'both') {
        const result = [];
        for (const edge of edges) {
          if ((direction === 'outgoing' || direction === 'both') && edge.sourcePath === filePath) {
            const t = nodes.get(edge.targetPath); if (t) result.push({ edge, node: t });
          }
          if ((direction === 'incoming' || direction === 'both') && edge.targetPath === filePath) {
            const s = nodes.get(edge.sourcePath); if (s) result.push({ edge, node: s });
          }
        }
        return result;
      },
    };
    return graph;
  }

  async function buildGraph() {
    const snapshot = await snapshotReady;
    // The kit reads files, takenAt and branch from KB_SNAPSHOT next to the graph.
    window.KB_SNAPSHOT = snapshot;
    return makeGraph(snapshot);
  }

  // -- talking to the chat -----------------------------------------------------
  function toast(text) {
    let box = document.getElementById('hexis-bridge-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'hexis-bridge-toast';
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'padding:8px 14px;border-radius:8px;background:#37352f;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;transition:opacity .2s;';
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.style.opacity = '1';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { box.style.opacity = '0'; }, 3200);
  }
  async function sendToChat(text) {
    const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text: String(text) }] });
    if (result && result.isError) throw new Error('the host did not take the message');
    toast('Sent to the chat. Claude will make the change.');
  }
  async function openLink(url) {
    const result = await request('ui/open-link', { url });
    if (result && result.isError) throw new Error('the host did not open the link');
  }

  // The kit's "copy changes" flow exists so a person can paste them into the
  // chat. Inside the chat, the bridge sends them instead.
  (function routeClipboard() {
    try {
      const clip = navigator.clipboard;
      const original = clip && typeof clip.writeText === 'function' ? clip.writeText.bind(clip) : null;
      // Tried rather than gated on hostCapabilities.message: hosts that handle
      // ui/message do not all advertise it. A host that refuses gets the copy.
      const writeText = async (text) => {
        if (initialized) {
          try {
            await sendToChat(text);
          } catch (e) {
            if (original) return original(text);
            throw e;
          }
          if (original) { try { await original(text); } catch (e) { /* the message is what counts */ } }
          return;
        }
        if (original) return original(text);
        throw new Error('clipboard unavailable');
      };
      if (clip) Object.defineProperty(clip, 'writeText', { value: writeText, configurable: true });
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    } catch (e) { /* leave the page's own fallback in charge */ }
  })();

  // A link the page follows (an anchor, window.bevel.openNode / navigate) is
  // opened OUT of the frame, where the same link goes in the app: the server
  // resolves it with the app's own grammar and scheme allowlist (the link
  // tool), and the host opens the address. A link it refuses opens nothing.
  async function openHref(href) {
    try {
      const result = await callServer(CFG.linkTool, { view: CFG.view, href, branch: CFG.branch }, 'a link');
      const url = result && result.structuredContent && result.structuredContent.url;
      if (typeof url !== 'string' || !url) {
        const text = result && Array.isArray(result.content) ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ') : '';
        toast(text || 'This link cannot be opened.');
        return;
      }
      if (hostCaps.openLinks) await openLink(url).catch(() => toast('Could not open ' + url));
      else toast(url);
    } catch (e) {
      toast('Could not open the link: ' + (e && e.message ? e.message : e));
    }
  }
  // A file of the knowledge base, by its path in the repository's folder: a
  // root-relative link, which the grammar reads as exactly that path. Each
  // segment is encoded, so a # or % in a file's name stays part of the name
  // instead of starting a fragment or an escape.
  const openKbFile = (repoPath) =>
    openHref('/' + [CFG.kbDir].concat(repoPath.split('/')).map((part) => encodeURIComponent(part)).join('/'));

  // -- size, display mode and the host's look ------------------------------------
  // The page as written is tall (and often 100vh); the compact presentation is
  // as tall as its content. Each reports its own range.
  let lastHeight = 0;
  function reportSize() {
    if (!initialized || hostContext.displayMode === 'fullscreen') return;
    const compact = document.documentElement.classList.contains('hx-native') ? document.getElementById('hx-native') : null;
    const natural = compact
      ? Math.ceil(compact.getBoundingClientRect().height)
      : Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const height = compact ? Math.min(720, Math.max(160, natural)) : Math.min(760, Math.max(480, natural));
    if (height === lastHeight) return;
    lastHeight = height;
    notify('ui/notifications/size-changed', { height });
  }
  async function requestDisplayMode(mode) {
    const r = await request('ui/request-display-mode', { mode });
    const actual = (r && r.mode) || mode;
    if (actual !== hostContext.displayMode) {
      hostContext.displayMode = actual;
      lastHeight = 0;
      emit('context', hostContext);
    }
    return actual;
  }
  // The host's theme and CSS variables (spec: hostContext.styles), so the compact
  // presentation matches the chat around it, dark mode included.
  function applyHostLook() {
    const vars = hostContext.styles && hostContext.styles.variables;
    if (vars) for (const k of Object.keys(vars)) if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
    if (hostContext.theme) document.documentElement.setAttribute('data-hx-theme', hostContext.theme);
  }

  // -- the protocol ------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== host) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.method === undefined && msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'request failed')); else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      // A request from the host: teardown and ping are the ones a view answers.
      if (msg.method === 'ui/resource-teardown' || msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
      return;
    }
    switch (msg.method) {
      case 'ui/notifications/tool-result': {
        const snap = snapshotOf(msg.params);
        if (snap) deliver(snap);
        else fetchLive();
        break;
      }
      case 'ui/notifications/tool-cancelled':
        fetchLive();
        break;
      case 'ui/notifications/host-context-changed':
        Object.assign(hostContext, msg.params || {});
        applyHostLook();
        lastHeight = 0;
        emit('context', hostContext);
        reportSize();
        break;
      default:
        break;
    }
  });

  window.bevel = Object.assign(window.bevel || {}, { buildGraph, sendToChat, openLink });
  // The app's own navigation runtime (platform-shared HTML_NAV_BRIDGE), the
  // same source the app's sandboxed frame runs: window.bevel.openNode and
  // navigate, anchor clicks, fragments scrolled in the frame. Its parent is
  // this bridge, which opens what it posts.
  (function (parent) {
${HTML_NAV_BRIDGE}
  })({ postMessage: (msg) => { if (msg && msg.type === 'bevel.navigate' && typeof msg.href === 'string') openHref(msg.href); } });
  window.__hexis = {
    cfg: CFG,
    context: () => hostContext,
    on, sendToChat, openLink, openKbFile, requestDisplayMode, toast, reportSize,
  };

  request('ui/initialize', {
    appInfo: { name: 'hexis-knowledge-view', version: '0.1.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: PROTOCOL,
  }).then((result) => {
    hostCaps = (result && result.hostCapabilities) || {};
    hostContext = (result && result.hostContext) || {};
    initialized = true;
    applyHostLook();
    notify('ui/notifications/initialized', {});
    const ready = () => {
      emit('context', hostContext);
      reportSize();
      if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.documentElement);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
    // A host that never sends this view a tool result (it was opened from a
    // resource list, or the result was dropped) still gets live data.
    setTimeout(() => { if (!settled) fetchLive(); }, 30000);
  }).catch((e) => deliver(null, 'the host did not answer: ' + (e && e.message ? e.message : e)));
})();
`;

/** JSON that is safe inside a <script>: no `</script`, no `<!--`. */
const scriptSafeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The bridge as one `<script>` element, configured for one view. */
export function bridgeScript(config: BridgeConfig): string {
  return `<script data-hexis-bridge>${BRIDGE_SOURCE.replace('__HEXIS_BRIDGE_CONFIG__', () => scriptSafeJson(config))}</script>`;
}

/**
 * The page with the bridge as its first script (right after `<head>`, else at
 * the very top), followed by the compact presentation (native.ts).
 */
export function injectBridge(html: string, config: BridgeConfig): string {
  const script = `${bridgeScript(config)}\n${nativeMarkup()}`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${script}\n${html.slice(at)}`;
  }
  return `${script}\n${html}`;
}
