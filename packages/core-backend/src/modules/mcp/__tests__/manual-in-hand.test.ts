import { describe, expect, it, vi } from 'vitest';
import { CommunicationProtocol } from '@utcp/sdk';
import { registerCallable, type DirectCommunicationProtocol } from '@utcp/direct-call';
import { ManualInHand } from '../manual-in-hand.js';

/**
 * A manual read in process reaches a tool client through the `direct-call`
 * protocol, which discovers a manual by calling the function registered under
 * its `callable_name`. Asserted against the real protocol, which keeps one
 * function per name for the whole process.
 */
const protocol = () => CommunicationProtocol.communicationProtocols['direct-call'] as DirectCommunicationProtocol;

/** What the protocol's function for `name` answers, called as the protocol calls it when it discovers a manual. */
const discover = (name: string) => protocol().getCallable(name)!();

describe('ManualInHand', () => {
  it('registers nothing when the MCP service is loaded: a function is registered when the composition makes one of these', async () => {
    const registered = vi.spyOn(protocol(), 'registerCallable');
    await import('../mcp.service.js');
    expect(registered).not.toHaveBeenCalled();

    const inHand = new ManualInHand(registerCallable);
    expect(registered.mock.calls.map(([name]) => name)).toEqual([inHand.callableName]);
    registered.mockRestore();
  });

  it('answers, within a registration, the manual that registration carries', async () => {
    const inHand = new ManualInHand(registerCallable);
    expect(await inHand.carry({ tools: ['a'] }, async () => discover(inHand.callableName))).toEqual({ tools: ['a'] });
  });

  // Every manual of a surface registers at once, and so do the surfaces of
  // different people: each registration must be handed its own manual.
  it('hands each of two registrations under way at once its own manual', async () => {
    const inHand = new ManualInHand(registerCallable);
    const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const [ada, bob] = await Promise.all([
      inHand.carry('ada', async () => {
        await later(10);
        return discover(inHand.callableName);
      }),
      inHand.carry('bob', async () => discover(inHand.callableName)),
    ]);
    expect([ada, bob]).toEqual(['ada', 'bob']);
  });

  it('refuses a discovery that no registration of its own carries a manual for', () => {
    const inHand = new ManualInHand(registerCallable);
    expect(() => discover(inHand.callableName)).toThrow('no manual was read for this registration');
  });

  // Two graphs in one process (two knowledge bases, or successive test
  // graphs) each keep their own function: neither answers from the other's
  // registrations.
  it('registers each under a name of its own, so two in one process never answer for each other', async () => {
    const first = new ManualInHand(registerCallable);
    const second = new ManualInHand(registerCallable);
    expect(first.callableName).not.toBe(second.callableName);
    expect(await first.carry('first', async () => discover(first.callableName))).toBe('first');
    expect(() => second.carry('second', () => discover(first.callableName))).toThrow('no manual was read for this registration');
  });
});
