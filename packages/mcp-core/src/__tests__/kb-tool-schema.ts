/**
 * A knowledge-base tool's input schema, in the exact shape the catalog serves.
 *
 * Not a convenience: the shape is the thing under test. `toolDef` (core-backend)
 * wraps a tool's flat arguments under a single `body` property with
 * `required: ['body']`, because `body_field: 'body'` is the only standard-http
 * way to ride several fields in a JSON body. So a chain calls
 * `TOOL({ body: { … } })`, and the arguments an example must supply are the
 * REQUIRED members of that inner object.
 *
 * `branch` is modelled exactly as `BRANCH_INPUT` declares it — a required
 * non-empty string with NO `default` and NO `enum`. That is what makes a
 * hardcoded argument list wrong: nothing in the catalog says which branch, so
 * an example that guesses one breaks on any deployment named otherwise.
 * `start_session` and the discovery tools take no arguments at all
 * (`kbToolSchema([])` → `{ body: {} }`), which is why one of them is the call
 * the description can print and stand behind.
 */
const PROPERTIES: Record<string, unknown> = {
  branch: {
    type: 'string',
    minLength: 1,
    description: 'The branch (draft) whose workspace this operates on.',
  },
  path: { type: 'string', description: 'Path to read, under `knowledge-base/`.' },
  pattern: { type: 'string', description: 'A JavaScript regular expression.' },
  content: { type: 'string', description: 'The content to write.' },
};

/** Arguments every KB tool accepts but none requires. */
const OPTIONAL: Record<string, unknown> = {
  offset: { type: 'integer', description: 'Start character index (default 0).' },
  limit: { type: 'integer', description: 'Max characters to return from `offset`.' },
  sessionId: { type: 'string', description: "This conversation's id." },
};

export function kbToolSchema(required: readonly string[]): unknown {
  const body =
    required.length === 0
      ? { type: 'object', properties: {}, additionalProperties: false }
      : {
          type: 'object',
          properties: {
            ...Object.fromEntries(required.map((key) => [key, PROPERTIES[key] ?? { type: 'string' }])),
            ...OPTIONAL,
          },
          required: [...required],
          additionalProperties: false,
        };
  return {
    type: 'object',
    properties: { body },
    required: ['body'],
    additionalProperties: false,
  };
}
