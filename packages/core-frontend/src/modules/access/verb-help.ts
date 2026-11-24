import type { Verb } from '@bevel-software/platform-shared';

/**
 * One line per access verb, in business words, under the name the app shows
 * for it. Hung as the tooltip and accessible description wherever a person
 * picks or reads a verb (the Manage access pickers, the rows' verb summaries,
 * the request radios, the Library's Owner pill), as the group / role / plugin
 * tags carry theirs, so each word is explained where it is met.
 *
 * Each line says what the verb adds to the ones it includes, which is the
 * resolver's own table (`VERB_REQUIRES` in platform-shared): edit and download
 * each include read, owner includes both, and edit does not include download.
 */
export const VERB_HELP = {
  read: 'Can read: open it and read it.',
  write:
    'Can edit: everything Can read allows, plus changing it, approving change requests to it and choosing who has access.',
  download: 'Can download: everything Can read allows, plus downloading a copy.',
  owner:
    'Owner: everything Can edit and Can download allow. Owners are also named as the people to ask about it.',
} as const satisfies Record<Verb, string>;
