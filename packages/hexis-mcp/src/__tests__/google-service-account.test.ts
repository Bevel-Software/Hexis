import { describe, expect, it } from 'vitest';
import { CommunicationProtocol } from '@utcp/sdk';
import { HttpCallTemplateSerializer } from '@utcp/http';
import { GoogleAuthHttpProtocol } from '@bevel-software/platform-mcp-core';
// The local server, loaded the way its entry point loads it.
import '../server.js';

/**
 * A `remote: false` tool runs here, so a Google service-account `auth` block
 * on it has to be understood here. Nothing in this package registers it: the
 * shared package does when it loads. What this pins is that the registration
 * landed in the registries THIS package's UTCP reads, which a second copy of
 * the SDK in the dependency tree would quietly break.
 */
describe('a Google service-account auth block in the local server', () => {
  const template = {
    call_template_type: 'http',
    http_method: 'GET',
    url: 'https://googleads.googleapis.com/v22/customers:listAccessibleCustomers',
    auth: { auth_type: 'google_service_account', credentials: '${GOOGLE_SA_KEY}', scopes: 'https://www.googleapis.com/auth/adwords' },
  };

  it('validates on a call template', () => {
    expect(new HttpCallTemplateSerializer().validateDict(template).auth).toEqual(template.auth);
  });

  it('is acted on by the http protocol the server calls tools through', () => {
    expect(CommunicationProtocol.communicationProtocols['http']).toBeInstanceOf(GoogleAuthHttpProtocol);
  });
});
