import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AuthUser } from '@bevel-software/platform-shared';
import { createOnboardingRoutes } from '../onboarding.routes.js';
import { StarterPackError, type StarterPackService } from '../starter-pack.service.js';

/**
 * The two starter-pack routes: the caller is the session's, the GET is never
 * cached, refusals keep their status and words, and a lock held elsewhere is
 * a 409 to try again rather than a 500.
 */

const ADA: AuthUser = { id: 'u-ada', email: 'ada@example.com', name: 'Ada' } as AuthUser;

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(
  svc: Pick<StarterPackService, 'status' | 'choose'>,
  as: AuthUser | null | (() => Promise<AuthUser | null>) = ADA,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createOnboardingRoutes(svc, typeof as === 'function' ? as : async () => as));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('GET /onboarding/starter-packs', () => {
  it('answers for the caller, uncached', async () => {
    const answer = { offered: true, chosen: null, packs: [], chosenPack: null };
    const svc = { status: vi.fn(async () => answer), choose: vi.fn() };
    const base = await listen(svc);
    const res = await fetch(`${base}/api/onboarding/starter-packs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(answer);
    expect(svc.status).toHaveBeenCalledWith(ADA);
  });

  it('is 401 without a user', async () => {
    const base = await listen({ status: vi.fn(), choose: vi.fn() }, null);
    expect((await fetch(`${base}/api/onboarding/starter-packs`)).status).toBe(401);
  });

  it('is 500, not 401, when the caller could not be looked up: an outage is not an expired session', async () => {
    const svc = { status: vi.fn(), choose: vi.fn() };
    const base = await listen(svc, async () => {
      throw new Error('database unreachable');
    });
    const res = await fetch(`${base}/api/onboarding/starter-packs`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/who is signed in/i);
    expect(svc.status).not.toHaveBeenCalled();
  });

  it('is 500 when the answer could not be had', async () => {
    const svc = {
      status: vi.fn(async () => {
        throw new Error('packs folder unreadable');
      }),
      choose: vi.fn(),
    };
    const base = await listen(svc);
    const res = await fetch(`${base}/api/onboarding/starter-packs`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load the starter packs' });
  });
});

describe('POST /onboarding/starter-pack', () => {
  it('chooses as the caller', async () => {
    const applied = { id: 'sales', name: 'Sales', pages: 2, skills: 3, summary: 'Added 2 pages and 3 skills for Sales.' };
    const svc = { status: vi.fn(), choose: vi.fn(async () => applied) };
    const base = await listen(svc);
    const res = await post(`${base}/api/onboarding/starter-pack`, { id: 'sales' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(applied);
    expect(svc.choose).toHaveBeenCalledWith(ADA, 'sales');
  });

  it('passes "none" through as the skip it is', async () => {
    const skipped = { id: 'none', name: null, pages: 0, skills: 0, summary: '' };
    const svc = { status: vi.fn(), choose: vi.fn(async () => skipped) };
    const base = await listen(svc);
    const res = await post(`${base}/api/onboarding/starter-pack`, { id: 'none' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(skipped);
    expect(svc.choose).toHaveBeenCalledWith(ADA, 'none');
  });

  it('needs an id', async () => {
    const base = await listen({ status: vi.fn(), choose: vi.fn() });
    expect((await post(`${base}/api/onboarding/starter-pack`, {})).status).toBe(400);
  });

  it('is 401 without a user, and 500 when the caller could not be looked up', async () => {
    const svc = { status: vi.fn(), choose: vi.fn() };
    const anonymous = await listen(svc, null);
    expect((await post(`${anonymous}/api/onboarding/starter-pack`, { id: 'sales' })).status).toBe(401);
    server?.close();
    const outage = await listen(svc, async () => {
      throw new Error('database unreachable');
    });
    expect((await post(`${outage}/api/onboarding/starter-pack`, { id: 'sales' })).status).toBe(500);
    expect(svc.choose).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'Only an admin can add starter pages.'],
    [404, 'There is no starter pack "astronomy".'],
    [409, 'Starter pages were already chosen for this knowledge base.'],
  ])('passes a refusal through with its status: %i', async (status, message) => {
    const svc = {
      status: vi.fn(),
      choose: vi.fn(async () => {
        throw new StarterPackError(message, status);
      }),
    };
    const base = await listen(svc);
    const res = await post(`${base}/api/onboarding/starter-pack`, { id: 'sales' });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });

  it('says nothing was changed, in its own words, when the write failed for a reason of its own', async () => {
    const svc = {
      status: vi.fn(),
      choose: vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device');
      }),
    };
    const base = await listen(svc);
    const res = await post(`${base}/api/onboarding/starter-pack`, { id: 'sales' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not add the starter pages. Nothing was changed.' });
  });

  it('turns a path locked by someone else into a 409 to retry', async () => {
    const svc = {
      status: vi.fn(),
      choose: vi.fn(async () => {
        throw new Error('Skipped editing "kb/KnowledgeBase/About us.md" — locked by Bo. Continuing with other edits; try this one again later.');
      }),
    };
    const base = await listen(svc);
    const res = await post(`${base}/api/onboarding/starter-pack`, { id: 'sales' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/try again/i);
  });
});
