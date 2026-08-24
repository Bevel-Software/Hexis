import type { Router, RequestHandler } from 'express';
import type { IToolRegistry } from '../tool-registry/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';

/**
 * `http_get` — one governed outbound GET.
 *
 * This exists for the code-mode chains that watch things: a gate waiting on a
 * deployment's health endpoint, a check that a URL came back up. Without it the
 * only way to poll something is to shell out, which means the polling runs with
 * whatever the surrounding process happens to have in its environment. With it,
 * the egress is a declared tool call: bounded, guarded, logged like any other,
 * and reviewable as a chain rather than as somebody's `curl`.
 *
 * The constraints are the whole point, so none of them are configurable:
 *
 * - **GET only.** A poller reads. A tool that could POST would be a
 *   general-purpose request forger sitting behind every connection key.
 * - **Public hosts only**, through the platform's existing SSRF guard rather
 *   than a second copy of that judgement. Note its documented limit: it catches
 *   literal internal targets, not DNS rebinding.
 * - **No caller-supplied headers.** Headers are where credentials live, and a
 *   tool that forwards them turns into a way to replay a secret at an arbitrary
 *   URL. Anything needing auth belongs in a `.tool` that declares its own
 *   variables and resolves them where it runs.
 * - **Bounded body and time**, because a poller that can be made to hang or to
 *   read a stream forever is a denial-of-service against the runner waiting on
 *   it.
 *
 * A non-2xx is a RESULT, not an error: "not up yet" is exactly what a gate
 * needs to see, and turning it into a thrown error would make the ordinary case
 * indistinguishable from a broken chain.
 */

/** Long enough for a cold service to answer, short enough that a wedged host doesn't hold a tick. */
const TIMEOUT_MS = 10_000;

/**
 * Body cap. Health endpoints answer in bytes; anything large is a page the
 * caller did not want, and reading it in full costs the platform's memory to no
 * one's benefit. Truncation is REPORTED so a chain can tell a short body from a
 * cut one.
 */
const MAX_BODY_BYTES = 64 * 1024;

export interface HttpGetResult {
  status: number;
  ok: boolean;
  /** Final URL after redirects — a health check that silently landed elsewhere is worth seeing. */
  url: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/** Perform the guarded GET. Exported so the rules are testable without a server. */
export async function governedHttpGet(rawUrl: string): Promise<HttpGetResult> {
  const url = assertSafeFetchUrl(rawUrl, { label: 'url' });
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: '*/*' },
  });

  // Read through the stream rather than `res.text()` so the cap is enforced on
  // what is actually pulled off the socket, not on what arrived.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_BODY_BYTES - size;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  }

  return {
    status: res.status,
    ok: res.ok,
    url: res.url || url.toString(),
    contentType: res.headers.get('content-type'),
    body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8'),
    truncated,
  };
}

/**
 * Register `http_get` on both tool surfaces and host its endpoint.
 *
 * Both surfaces, deliberately: a code-mode probe reaches it through the local
 * MCP server (external), and the in-process agent reaches the same tool with
 * the same rules (internal). One implementation, so the guard cannot hold on
 * one path and not the other.
 */
export function registerHttpGetTool(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
): void {
  const def = () =>
    toolDef({
      name: 'http_get',
      description:
        'Fetch a public URL with a plain GET and return its status and body. Built for polling — a ' +
        'health endpoint, a status page, a deployment that should be back up — from a `call_tool_chain`. ' +
        'A non-2xx status is returned normally (that is usually the answer you are waiting for), not ' +
        'raised as an error. GET only, no custom headers, no credentials: a URL needing authentication ' +
        'belongs in a `.tool` that declares its own variables. Internal, loopback and cloud-metadata ' +
        'addresses are refused. The body is capped (`truncated` says whether it was cut) and the ' +
        'request times out after a few seconds.',
      path: '/agent/tools/http_get',
      inputs: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL of a publicly reachable host.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      outputs: {
        type: 'object',
        properties: {
          status: { type: 'number', description: 'HTTP status code.' },
          ok: { type: 'boolean', description: 'Whether the status was 2xx.' },
          url: { type: 'string', description: 'Final URL after any redirects.' },
          contentType: { type: 'string', description: 'Response `content-type`, if the server sent one.' },
          body: { type: 'string', description: 'Response body as text, capped.' },
          truncated: { type: 'boolean', description: 'Whether the body was cut at the cap.' },
        },
      },
      tags: ['http'],
    });
  registry.registerExternalTool(def);
  registry.registerInternalTool(def);

  router.post(
    '/agent/tools/http_get',
    toolAuth,
    toolHandler(async (args) => {
      const url = typeof (args as { url?: unknown })?.url === 'string' ? (args as { url: string }).url : '';
      return governedHttpGet(url);
    }),
  );
}
