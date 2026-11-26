import { afterEach, describe, expect, it } from 'vitest';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { DefaultVariableSubstitutor, UtcpClientConfigSerializer } from '@utcp/sdk';
import {
  installSubstitutionCapture,
  manualSecrets,
  recordingSubstitutions,
  rememberManualSecrets,
} from '../call-secrets.js';

type Substitutor = { substitute(o: unknown, c: unknown, n: string): Promise<unknown>; _getVariable: unknown };

const clients: CodeModeUtcpClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function clientWith(variables: Record<string, string>): Promise<CodeModeUtcpClient> {
  const client = await CodeModeUtcpClient.create(process.cwd(), new UtcpClientConfigSerializer().validateDict({ variables }));
  clients.push(client);
  return client;
}

const substitutorOf = (client: CodeModeUtcpClient) => (client as unknown as { variableSubstitutor: Substitutor }).variableSubstitutor;

describe('substitution capture', () => {
  it('finds the lookup it wraps in the installed @utcp/sdk (fails when a release renames it)', () => {
    const substitutor = new DefaultVariableSubstitutor() as unknown as { _getVariable?: unknown };
    expect(typeof substitutor._getVariable).toBe('function');
  });

  it('records what each registration resolves, two at once kept apart, and nothing outside one', async () => {
    const client = await clientWith({ a_TOKEN: 'value-for-a-123', b_TOKEN: 'value-for-b-456' });
    installSubstitutionCapture(client);
    const fill = (manual: string, delay: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return substitutorOf(client).substitute({ headers: { Authorization: 'Bearer ${TOKEN}' } }, client.config, manual);
    };

    const [[, a], [, b]] = await Promise.all([recordingSubstitutions(fill('a', 20)), recordingSubstitutions(fill('b', 0))]);
    expect([...a]).toEqual(['value-for-a-123']);
    expect([...b]).toEqual(['value-for-b-456']);

    // Outside a registration the substitutor still works, and no store gains anything.
    expect(await substitutorOf(client).substitute('${TOKEN}', client.config, 'b')).toBe('value-for-b-456');
    expect([...a]).toEqual(['value-for-a-123']);
    expect([...b]).toEqual(['value-for-b-456']);
    const [, outside] = await recordingSubstitutions(async () => undefined);
    expect([...outside]).toEqual([]);
  });

  it('keeps the values per client and manual, a later registration replacing them', () => {
    const client = {};
    rememberManualSecrets(client, 'notion', new Set(['old-value-1234']));
    rememberManualSecrets(client, 'notion', new Set(['new-value-5678']));
    expect([...manualSecrets(client, 'notion')]).toEqual(['new-value-5678']);
    expect([...manualSecrets(client, 'other')]).toEqual([]);
    expect([...manualSecrets({}, 'notion')]).toEqual([]);
  });

  it('wraps a client once however often it is installed', async () => {
    const client = await clientWith({});
    installSubstitutionCapture(client);
    const lookup = substitutorOf(client)._getVariable;
    installSubstitutionCapture(client);
    expect(substitutorOf(client)._getVariable).toBe(lookup);
  });
});
