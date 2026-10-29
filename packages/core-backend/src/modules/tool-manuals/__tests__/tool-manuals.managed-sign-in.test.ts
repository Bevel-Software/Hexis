import { describe, expect, test } from 'vitest';
import { normalizeToolManual } from '../tool-manuals.service.js';

/**
 * A sign-in that goes through a managed connector: the `oauth` block names
 * the connector instead of a client id, and — for a workspace connection —
 * may sit on an `admin`-scoped variable, the one case an OAuth block may.
 */
function manual(variable: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'microsoft365',
    type: 'inline',
    variables: [variable],
    tools: [
      {
        name: 'list_mail',
        description: 'List mail.',
        inputs: { type: 'object', properties: {} },
        outputs: { type: 'object', properties: {} },
        tool_call_template: {
          call_template_type: 'http',
          http_method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me/messages',
          headers: { Authorization: 'Bearer ${ACCESS_TOKEN}' },
        },
      },
    ],
  });
}

const ENDPOINTS = {
  authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

describe('a managed sign-in in a .tool', () => {
  test('parses without a clientId when `managed` names the connector and scope set', () => {
    const d = normalizeToolManual('m', 'Plugins/x/m.tool', manual({
      name: 'ACCESS_TOKEN',
      scope: 'user',
      oauth: { ...ENDPOINTS, scopes: ['Mail.Read'], managed: { connectorId: 'microsoft365', scopeSet: 'read' } },
    }));
    expect(d.variables?.[0].oauth).toEqual({
      ...ENDPOINTS,
      scopes: ['Mail.Read'],
      managed: { connectorId: 'microsoft365', scopeSet: 'read' },
    });
    expect(d.variables?.[0].oauth?.clientId).toBeUndefined();
  });

  test('still requires a clientId on an ordinary sign-in', () => {
    expect(() =>
      normalizeToolManual('m', 'Plugins/x/m.tool', manual({ name: 'ACCESS_TOKEN', scope: 'user', oauth: { ...ENDPOINTS } })),
    ).toThrow(/clientId/);
  });

  test('refuses a malformed `managed` reference without repeating it', () => {
    expect(() =>
      normalizeToolManual('m', 'Plugins/x/m.tool', manual({
        name: 'ACCESS_TOKEN',
        scope: 'user',
        oauth: { ...ENDPOINTS, managed: { connectorId: 'Micro Soft!', scopeSet: 'read' } },
      })),
    ).toThrow(/`variables\[0\]\.oauth\.managed` must be/);
  });

  test('a workspace connection: `oauth` on an `admin` variable is allowed only when managed', () => {
    const shared = normalizeToolManual('m', 'Plugins/x/m.tool', manual({
      name: 'ACCESS_TOKEN',
      scope: 'admin',
      oauth: { ...ENDPOINTS, managed: { connectorId: 'hubspot', scopeSet: 'read' } },
    }));
    expect(shared.variables?.[0]).toMatchObject({ scope: 'admin', oauth: { managed: { connectorId: 'hubspot' } } });

    expect(() =>
      normalizeToolManual('m', 'Plugins/x/m.tool', manual({ name: 'ACCESS_TOKEN', scope: 'admin', oauth: { ...ENDPOINTS, clientId: 'c' } })),
    ).toThrow(/scope` must be `user`/);
  });
});
