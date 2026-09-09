import { describe, expect, it } from 'vitest';
import { initials, labelInitials } from '../email';

/**
 * One monogram rule for every people surface: the same person gets the same
 * letters whether a surface holds their email, their name, or the
 * `Name <email>` label the access rules spell.
 */
describe('initials', () => {
  it('takes two initials from a two-word name, or from a first.last local part', () => {
    expect(initials('Ali Vega')).toBe('AV');
    expect(initials('ali.vega@x.io')).toBe('AV');
    expect(initials('ali_vega@x.io')).toBe('AV');
  });

  it('takes the first two characters of a one-word name or local part', () => {
    expect(initials('Ali')).toBe('AL');
    expect(initials('ali@x.io')).toBe('AL');
  });

  it('reads the NAME of a `Name <email>` label — the address never lends a second word', () => {
    expect(initials('Ali Vega <ali@x.io>')).toBe('AV');
    expect(initials('Ali <ali.vega@x.io>')).toBe('AL');
    // A label that is only an address falls back to it.
    expect(initials('<ali.vega@x.io>')).toBe('AV');
    // A display name is taken whole — an `@` inside it is not an address.
    expect(initials('Ops @ Night <ops@x.io>')).toBe('O@');
  });

  it('answers ? for nothing', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('labelInitials', () => {
  it('reads a collective label as words — an @ in a group name is just a character', () => {
    expect(labelInitials('Product Team')).toBe('PT');
    expect(labelInitials('Engineering')).toBe('EN');
    expect(labelInitials('ops@night')).toBe('OP');
    expect(labelInitials('gtm-readers')).toBe('GR');
    expect(labelInitials('')).toBe('?');
  });
});
