/**
 * A knowledge-base tool's input schema, in the catalog's exact WRAPPING shape
 * — a deliberately reduced subset of any one tool's real argument list.
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
 *
 * The OPTIONAL arguments, by contrast, are a reduced subset and not per tool:
 * only the read/search tools really take `offset`/`limit`, and the write tools
 * declare a `mode` with an `enum` and a default that this fixture omits. They
 * cannot change what it tests — `satisfyingValue` writes REQUIRED properties
 * only, so what an optional argument exercises is that it stays out of the
 * example, which is the same test whichever tool carries it. Do not read a
 * tool's real signature off this file.
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

/**
 * Optional arguments, attached to every tool here rather than to the ones that
 * really take them: what they exercise is that an OPTIONAL argument stays out
 * of the example, and that is the same test whichever tool carries it.
 */
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
