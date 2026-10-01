import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAgentRestAuditMiddleware } from '../agent-rest-audit.middleware.js';
import type { AgentEventInput } from '../audit.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';

const KB = 'KNOWLEDGE_BASE';

/**
 * The REST recorder, on a real router: a stand-in auth stamps whatever
 * `toolAuth` a test wants (the way the real gate does, per route), a couple
 * of routes answer as the platform tools do, and the recorder is watched.
 */
function makeApp(auth: ToolAuth | null, skills: { name: string; path: string }[] = []) {
  const events: AgentEventInput[] = [];
  const skillFolders = vi.fn(async () => skills);
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(
    '/agent/tools/:name',
    createAgentRestAuditMiddleware({ recorder: { record: (e) => void events.push(e) }, kbManualName: KB, skillFolders }),
  );
  const stampAuth: express.RequestHandler = (req, res, next) => {
    if (!auth) {
      res.status(401).json({ error: 'nope' });
      return;
    }
    req.toolAuth = auth;
    next();
  };
  router.post('/agent/tools/get_skill', stampAuth, (_req, res) => res.json({ ok: true }));
  router.post('/agent/tools/read_file', stampAuth, (_req, res) => res.json({ content: 'x' }));
  router.post('/agent/tools/list_skills', stampAuth, (_req, res) => res.json({ skills }));
  router.post('/agent/tools/boom', stampAuth, (_req, res) => res.status(500).json({ error: 'kaboom' }));
  app.use('/api', router);
  return { app, events, skillFolders };
}

let server: Server;
afterEach(() => server?.close());

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

const post = (base: string, name: string, body: unknown) =>
  fetch(`${base}/api/agent/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Recording lands after the response; give it a turn. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const EXCHANGED_GRANT: ToolAuth = { source: 'external', userId: 'u-1', connectionId: 'conn-1', scope: 'write' };

describe('the REST recorder for the local server', () => {
  it("records a skill read made with an exchanged grant as that agent's skill event, with the outcome", async () => {
    const { app, events } = makeApp(EXCHANGED_GRANT, [{ name: 'rfi', path: 'Plugins/Sales/rfi' }]);
    const base = await listen(app);
    expect((await post(base, 'get_skill', { name: 'rfi' })).status).toBe(200);
    expect((await post(base, 'boom', {})).status).toBe(500);
    await settle();
    expect(events).toEqual([
      expect.objectContaining({
        userId: 'u-1',
        principal: { kind: 'agent', id: 'conn-1' },
        kind: 'skill',
        manual: 'Plugins/Sales/rfi',
        name: 'rfi',
        outcome: 'ok',
      }),
      expect.objectContaining({ kind: 'capability', name: 'boom', outcome: 'error' }),
    ]);
    expect(typeof events[0]!.durationMs).toBe('number');
  });

  it('fetches the skill catalog only for a read that names a path, and classifies the read by it', async () => {
    const { app, events, skillFolders } = makeApp(EXCHANGED_GRANT, [{ name: 'rfi', path: 'Plugins/Sales/rfi' }]);
    const base = await listen(app);
    await post(base, 'list_skills', {});
    await post(base, 'read_file', { path: 'Plugins/Sales/rfi/SKILL.md', branch: 'main' });
    await settle();
    expect(skillFolders).toHaveBeenCalledTimes(1);
    expect(events.map((e) => `${e.kind}:${e.name}`)).toEqual(['capability:list_skills', 'skill:rfi']);
  });

  it('records nothing for a connection key, a loopback token, or a refused call — those are the proxy\'s to record, or nobody\'s', async () => {
    const key = makeApp({ source: 'external', userId: 'u-1', tokenId: 'k-1', scope: 'write' });
    let base = await listen(key.app);
    await post(base, 'get_skill', { name: 'rfi' });
    server.close();
    const loopback = makeApp({ source: 'external', userId: 'u-1', scope: 'write' });
    base = await listen(loopback.app);
    await post(base, 'get_skill', { name: 'rfi' });
    server.close();
    const refused = makeApp(null);
    base = await listen(refused.app);
    expect((await post(base, 'get_skill', { name: 'rfi' })).status).toBe(401);
    await settle();
    expect(key.events).toEqual([]);
    expect(loopback.events).toEqual([]);
    expect(refused.events).toEqual([]);
  });
});
