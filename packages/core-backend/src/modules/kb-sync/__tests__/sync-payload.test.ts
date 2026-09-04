import { describe, expect, it } from 'vitest';
import { parseSyncPayload } from '../sync-payload.js';

describe('parseSyncPayload', () => {
  it('an empty or foreign body syncs everything', () => {
    expect(parseSyncPayload(undefined)).toEqual({ source: 'none', branches: 'all', invalid: [] });
    expect(parseSyncPayload({ hello: 'world' })).toEqual({ source: 'none', branches: 'all', invalid: [] });
    expect(parseSyncPayload('text')).toEqual({ source: 'none', branches: 'all', invalid: [] });
  });

  it('explicit branches are kept in order, trimmed and de-duplicated', () => {
    expect(parseSyncPayload({ branches: [' main ', 'ali/x', 'main'] })).toEqual({
      source: 'explicit',
      branches: ['main', 'ali/x'],
      invalid: [],
    });
  });

  it('an explicit name git would refuse is reported, not silently dropped', () => {
    const parsed = parseSyncPayload({ branches: ['main', '--upload-pack=x', 'a..b', 7] });
    expect(parsed.branches).toEqual(['main']);
    expect(parsed.invalid).toEqual(['--upload-pack=x', 'a..b', '7']);
  });

  it('an explicit `branches` that is not a list means everything', () => {
    expect(parseSyncPayload({ branches: 'main' }).branches).toBe('all');
  });

  it('Azure DevOps push: every updated head ref, tags ignored', () => {
    const parsed = parseSyncPayload({
      eventType: 'git.push',
      resource: {
        refUpdates: [
          { name: 'refs/heads/main', oldObjectId: 'a', newObjectId: 'b' },
          { name: 'refs/tags/v1', oldObjectId: '0', newObjectId: 'c' },
          { name: 'refs/heads/ali/new-skill' },
        ],
      },
    });
    expect(parsed).toEqual({
      source: 'azure-devops',
      branches: ['main', 'ali/new-skill'],
      invalid: [],
    });
  });

  it('Azure DevOps pull request: target then source', () => {
    for (const eventType of ['git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged']) {
      const parsed = parseSyncPayload({
        eventType,
        resource: {
          sourceRefName: 'refs/heads/ali/new-skill',
          targetRefName: 'refs/heads/main',
          status: 'completed',
        },
      });
      expect(parsed).toEqual({
        source: 'azure-devops',
        branches: ['main', 'ali/new-skill'],
        invalid: [],
      });
    }
  });

  it('an Azure DevOps event we do not know syncs everything', () => {
    expect(parseSyncPayload({ eventType: 'build.complete', resource: {} }).branches).toBe('all');
  });

  it('GitHub push: the pushed branch', () => {
    expect(parseSyncPayload({ ref: 'refs/heads/main', before: 'a', after: 'b' })).toEqual({
      source: 'github',
      branches: ['main'],
      invalid: [],
    });
  });

  it('GitHub tag push names nothing to sync', () => {
    expect(parseSyncPayload({ ref: 'refs/tags/v1' })).toEqual({
      source: 'github',
      branches: [],
      invalid: [],
    });
  });

  it('GitLab push: the pushed branch', () => {
    expect(parseSyncPayload({ object_kind: 'push', ref: 'refs/heads/main' })).toEqual({
      source: 'gitlab',
      branches: ['main'],
      invalid: [],
    });
  });
});
