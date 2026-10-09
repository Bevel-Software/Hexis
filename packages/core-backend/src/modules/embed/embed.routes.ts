import express from 'express';
import type { IEmbedService } from './embed.interface.js';
import {
  EmbedAccessError,
  EmbedLockedError,
  EmbedNodeNotFoundError,
  EmbedTokenError,
} from './embed.errors.js';
import { EmbedRefParseError } from './embed-link.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/**
 * What `/api/embed/raw` answers as `Content-Type`, by extension — the types a
 * renderer draws from a URL. Anything else is bytes the renderer parses
 * itself (a workbook, a deck), served as the octet stream it is.
 */
const RAW_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

/**
 * The embed surface: a token-minted, pseudonymous, short-lived page that
 * renders ONE knowledge-base file with the app's own renderer, inside
 * somebody else's frame — an MCP App's sandbox in a chat, an Atlassian issue
 * panel. Two routers, with deliberately different auth stories:
 *
 *  - {@link createEmbedRoutes} (mounted at the app root, ahead of the JWT
 *    middleware): the connector's shared-secret mint, and the TOKEN-ONLY data
 *    routes the SPA `/embed` page calls. Also stamps the framing headers on
 *    the two SPA routes.
 *  - {@link createEmbedLinkRoutes} (mounted under the JWT middleware): links
 *    the viewer's outside account to their just-authenticated Hexis user.
 *
 * Mounted before the production static catch-all, so the framing headers are
 * stamped before `index.html` is served for `/embed*`.
 *
 * ── Why the data routes take the token and NOTHING else ───────────────────
 *
 * The embed page is framed by any site (see the framing headers below), which
 * is what makes it work in every host's sandbox without an admin entry per
 * host. The security of the embed therefore rests entirely on the token:
 * short-lived, scoped to one file and one identity, pseudonymous. A session
 * FALLBACK would hand that away — a hostile page could frame `/embed`, and
 * the browser would attach the visitor's own cookie to every data request the
 * page made, so the attacker's frame would read and write as the victim. So
 * every route here reads `token` and never `req.userId`: a request carrying a
 * perfectly valid session and no token is refused.
 *
 * ── Cross-origin callers ──────────────────────────────────────────────────
 *
 * The MCP App view runs the embed inside a chat host's SANDBOX — another
 * origin, unknowable in advance (a hash subdomain under Claude's content
 * domain, a URL-derived one under ChatGPT's) — and calls the token routes
 * from there. Nothing here has to allow that: the server's app-wide CORS
 * (`create-core-server.ts`, mounted ahead of this router) already reflects
 * any origin and answers the preflight, for every route. That is safe on the
 * token routes for the reason the token-only rule exists: CORS guards a
 * browser's ambient credentials, these routes take none, and the token in
 * the request is the whole credential. The routes test mounts the same CORS
 * to pin that a cross-origin caller gets through.
 */

export function createEmbedRoutes(embedService: IEmbedService): express.Router {
  const router = express.Router();

  // ── framing ──────────────────────────────────────────────────────────────
  //
  // The embed page: NO framing restriction at all, so any host may frame it.
  // `X-Frame-Options` is removed rather than merely not set, so a header added
  // globally later (by this app or by a proxy in front of it) cannot silently
  // break every host's embed — the one route that must be frameable says so
  // itself.
  router.get('/embed', (_req, res, next) => {
    res.removeHeader('X-Frame-Options');
    // Only the framing directive goes: a policy's other directives (scripts,
    // objects, connections) protect the page whoever frames it, and stay.
    const csp = res.getHeader('Content-Security-Policy');
    if (typeof csp === 'string') {
      const kept = csp
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d !== '' && !/^frame-ancestors\b/i.test(d));
      if (kept.length > 0) res.setHeader('Content-Security-Policy', kept.join('; '));
      else res.removeHeader('Content-Security-Policy');
    }
    next();
  });
  // The account-link page is the opposite: it acts under the viewer's own
  // SESSION, so a page that could frame it could link a foreign account to
  // whoever happened to be signed in. Refused for EVERY ancestor — the modern
  // directive and the legacy header, since not every browser honours both.
  router.get('/embed/link', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // ── the connector's mint (server-to-server, shared secret) ───────────────
  router.post('/api/embed/token', async (req, res) => {
    if (!embedService.sharedSecretConfigured()) {
      res.status(404).json({ error: 'The shared-secret mint is not configured' });
      return;
    }
    if (!embedService.verifySharedSecret(req.header('x-embed-secret') ?? undefined)) {
      res.status(401).json({ error: 'Invalid embed secret' });
      return;
    }
    const b = req.body as { accountId?: unknown; email?: unknown; reference?: unknown };
    if (typeof b?.accountId !== 'string' || typeof b?.reference !== 'string') {
      res.status(400).json({ error: 'accountId and reference are required' });
      return;
    }
    try {
      res.json(
        await embedService.mintToken({
          accountId: b.accountId,
          email: typeof b.email === 'string' ? b.email : undefined,
          reference: b.reference,
        }),
      );
    } catch (err) {
      sendJsonError(res, err);
    }
  });

  // ── token-only data routes ───────────────────────────────────────────────

  // The file to render, plus the viewer's read/write status.
  router.get('/api/embed/load', async (req, res) => {
    const token = queryToken(req, res);
    if (token === null) return;
    // Protected text and a token-bearing link URL: as with `/raw`, nothing
    // may keep the answer past the access it was computed under.
    res.setHeader('Cache-Control', 'no-store, private');
    try {
      res.json(await embedService.loadFile(token));
    } catch (err) {
      sendJsonError(res, err);
    }
  });

  // The file's BYTES, for the app renderers that read bytes rather than a
  // text buffer: an image, a PDF, a Word document — and the pictures a
  // markdown page references, which arrive as `path`.
  router.get('/api/embed/raw', async (req, res) => {
    // The token is in the URL, so no shared cache may keep ANY answer from
    // it — a refusal included, which is why this is set before the token is
    // even looked at.
    res.setHeader('Cache-Control', 'no-store, private');
    const token = queryToken(req, res);
    if (token === null) return;
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    try {
      const { bytes, path: served } = await embedService.readBytes(token, path);
      // The type from the extension, as the workspace raw route serves it:
      // under `nosniff` a browser draws an `<img>` only from an `image/*`
      // answer, and never sniffs SVG at all, so an octet-stream picture is a
      // broken image.
      const ext = served.slice(served.lastIndexOf('.')).toLowerCase();
      res.setHeader('Content-Type', RAW_MIME_TYPES[ext] ?? 'application/octet-stream');
      // An SVG can carry scripts; drawn through `<img>` they never run, but a
      // tab opened on this address would run them under the app's origin.
      if (ext === '.svg') res.setHeader('Content-Security-Policy', 'sandbox');
      // Never a download, always bytes for a renderer to draw: an embed is a
      // view, and `download:` is a separate verb the app's own route gates.
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Embed-Path', encodeURIComponent(served));
      res.end(bytes);
    } catch (err) {
      sendJsonError(res, err);
    }
  });

  // Lock lifecycle: Edit → lock, timer → heartbeat, Cancel/close → cancel.
  router.post('/api/embed/lock', tokenHandler(async (token) => embedService.acquireLock(token)));
  router.post(
    '/api/embed/heartbeat',
    tokenHandler(async (token) => {
      await embedService.heartbeat(token);
      return null;
    }),
  );
  router.post(
    '/api/embed/cancel',
    tokenHandler(async (token) => {
      await embedService.cancel(token);
      return null;
    }),
  );

  // Save to the default branch (a writer), or propose (anybody else).
  router.post('/api/embed/save', contentHandler(async (token, content) => {
    await embedService.save(token, content);
    return null;
  }));
  router.post('/api/embed/propose', contentHandler(async (token, content) =>
    embedService.propose(token, content),
  ));

  return router;
}

/**
 * Links the authenticated Hexis user to the outside account the embed token
 * carries. JWT-protected — `req.userId` is the user we link TO, which is why
 * the page it is called from refuses every framing ancestor.
 */
export function createEmbedLinkRoutes(embedService: IEmbedService): express.Router {
  const router = express.Router();

  router.post('/embed/link', async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const b = req.body as { token?: unknown };
    if (typeof b?.token !== 'string') {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    try {
      await embedService.linkAccount(b.token, req.userId);
      res.status(204).end();
    } catch (err) {
      sendJsonError(res, err);
    }
  });

  // Connected-apps management (list + disconnect). A person's ability to see
  // and remove their OWN link — self-service erasure — must not depend on
  // whether the shared-secret mint happens to be configured today.
  router.get('/embed/links', async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      res.json(await embedService.listLinkedAccounts(req.userId));
    } catch (err) {
      sendJsonError(res, err);
    }
  });

  router.delete('/embed/links/:accountId', async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const removed = await embedService.unlinkAccount(req.userId, req.params.accountId);
      if (!removed) {
        // Not linked to THIS user (absent, or somebody else's) — the same 404
        // either way, so the endpoint cannot probe other people's links.
        res.status(404).json({ error: 'No such connected app' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      sendJsonError(res, err);
    }
  });

  return router;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The `token` query parameter, or null after answering 401.
 *
 * 401, not 400: a request with no token is a request with no CREDENTIAL here,
 * whatever else it carries. Saying "unauthorized" is what tells a session-only
 * caller — the case the token-only rule exists for — that it was refused for
 * who it is rather than for how it was spelled.
 */
function queryToken(req: express.Request, res: express.Response): string | null {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    res.status(401).json({ error: TOKEN_REQUIRED });
    return null;
  }
  return token;
}

/** What a tokenless request is told, on every embed data route. */
export const TOKEN_REQUIRED =
  'This view needs its embed token. A session is not accepted here.';

/** Build a handler for a `{ token }`-body endpoint; a null result → 204. */
function tokenHandler(run: (token: string) => Promise<unknown>): express.RequestHandler {
  return async (req, res) => {
    const token = (req.body as { token?: unknown })?.token;
    if (typeof token !== 'string' || token === '') {
      res.status(401).json({ error: TOKEN_REQUIRED });
      return;
    }
    try {
      const result = await run(token);
      if (result === null || result === undefined) res.status(204).end();
      else res.json(result);
    } catch (err) {
      sendJsonError(res, err);
    }
  };
}

/** Build a handler for a `{ token, content }`-body endpoint. */
function contentHandler(
  run: (token: string, content: string) => Promise<unknown>,
): express.RequestHandler {
  return async (req, res) => {
    const b = req.body as { token?: unknown; content?: unknown };
    if (typeof b?.token !== 'string' || b.token === '') {
      res.status(401).json({ error: TOKEN_REQUIRED });
      return;
    }
    if (typeof b?.content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    try {
      const result = await run(b.token, b.content);
      if (result === null || result === undefined) res.status(204).end();
      else res.json(result);
    } catch (err) {
      sendJsonError(res, err);
    }
  };
}

function statusFor(err: unknown): number {
  if (err instanceof EmbedTokenError) return 401;
  if (err instanceof EmbedAccessError) return 403;
  if (err instanceof EmbedNodeNotFoundError) return 404;
  if (err instanceof EmbedLockedError) return 409;
  if (err instanceof EmbedRefParseError) return 400;
  // A domain error from the workflow layer (a protected-branch refusal, a
  // duplicate request) already carries the status it deserves.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 600) return status;
  return 500;
}

function messageFor(err: unknown): string {
  if (
    err instanceof EmbedTokenError ||
    err instanceof EmbedAccessError ||
    err instanceof EmbedNodeNotFoundError ||
    err instanceof EmbedLockedError ||
    err instanceof EmbedRefParseError
  ) {
    return err.message;
  }
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && err instanceof Error) {
    return err.message;
  }
  return 'Something went wrong.';
}

function sendJsonError(res: express.Response, err: unknown): void {
  const status = statusFor(err);
  if (status === 500) console.error('[embed] unexpected error:', err);
  res.status(status).json({ error: messageFor(err) });
}
