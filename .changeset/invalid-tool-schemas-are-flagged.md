---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A connected tool's input schema is no longer truncated on its way to clients — it reaches them as its server sent it, apart from the two transformations the proxy has always documented (local `$ref` inlining, non-standard `format` dropped) and MCP's requirement that the root be `type: "object"` with a `properties` map. And a tool whose schema really is invalid is hidden with a marker its owner can read.

Three tools an AI client dropped on 2026-09-29 were not sent to us broken. Hexis broke them. `sanitizeInputSchema` (mcp-core) walked a remote server's schema with a depth cap, and past the cap it replaced whatever node it had reached with `{}`. Most places in a schema are not places where `{}` is a schema: past the cap an `anyOf` list became `anyOf: {}`, the entries of a `required` list became `required: [{}]`, and a `type: "object"` became `type: {}`. A real schema costs two levels of this walk per level of nesting (the `properties` keyword, then the field name), so the cap of 20 was reached at the eighth or ninth level of nesting — ordinary for HubSpot's and Notion's schemas. The client then refused the tool, said nothing to the agent about it, and named the server.

## The three tools: as sent, as offered

Captured by running the pre-change and post-change `toListedTool` over schemas of the reported shapes, nested to the depth at which each reported refusal appears, and meta-validating both with `ajv` (the validator the clients and the MCP SDK use). Each reason below is `ajv`'s own, reproduced to the character from the ticket.

| Tool | At | As the server sends it | As Hexis offered it, BEFORE | Identical? |
|---|---|---|---|---|
| HubSpot `manage_marketing_email` | `…/socialLinks/items/anyOf` | `"anyOf": [ {…}, {…} ]` | `"anyOf": {}` — *must be an array* | NO |
| Notion `notion-query-data-sources` | `…/value/anyOf/0/required/0` | `"required": ["id", "name"]` | `"required": [{}]` — *must be a string* | NO |
| Notion `notion-query-meeting-notes` | `…/value/properties/table/type` | `"type": "object"` | `"type": {}` — *must be equal to one of the allowed values* | NO |

AFTER this change all three are **identical** to what the server sent, and all three meta-validate clean. So the answer to the ticket's question is that neither Notion nor HubSpot sent an invalid schema: the proxy damaged valid ones, and the fix is ours. (Key ORDER can still change, because `@utcp/sdk` rebuilds each schema object through zod; a JSON object is unordered and no validator or client reads anything into it.)

## What changed

**The proxy passes schemas through (`@bevel-software/platform-mcp-core`).** `sanitizeInputSchema` keeps its two deliberate transformations — inlining local `$ref` pointers and dropping non-standard `format` values, both of which exist because the Anthropic tool validator rejects a tool over them — and changes nothing else. `toListedTool` still forces the root `type` to `"object"` and supplies a `properties` map when the server sent something else there, because MCP requires both of a tool's input schema and a client refuses the whole listing without them. Below the root, the guards no longer produce an invalid schema:

- a `$ref` that resolves back onto a schema already being inlined is recursive, and degrades to a permissive `{}` at that position, which is a schema position and therefore legal. So does one past the new expansion budget: `$ref`s that branch rather than nest (two `allOf` arms on one target, repeatedly) double per level, and a few hundred bytes on the wire could otherwise ask `tools/list` for a reply no memory holds;
- the depth cap (now 200, and a stack guard rather than a schema rule) keeps the SHAPE of what it stops at, replacing only the objects past it with `{}`. An `anyOf` stays a list, a `required` entry stays a string, a `type` stays a string — and because no object survives, nothing past the cap carries a `$ref` the dropped `$defs` block would leave dangling, or a `format` a client refuses;
- a `$ref` it cannot inline — recursive, or past the expansion budget — still leaves its SIBLINGS sanitized in its place, because those keywords are what stands where the reference was;
- and instance data — a `const`, `default`, `enum` or `examples` value — is handed back exactly as it came, at any depth. A key named `format` or `$ref` inside one of those is part of a value the tool expects, not a construct to rewrite, and `{}` there would not mean "any value" but a different default.

A test pins the pass-through with a schema carrying `anyOf` lists, `required` lists and nested `items`, at 1, 5, 8, 12 and 30 levels of nesting, and the two guards are pinned at depths and shapes no server sends.

**New: `inputSchemaDefect` and `schemaDefectMarker` (`@bevel-software/platform-mcp-core`).** The JSON Schema 2020-12 meta-schema check, via `ajv` — which is not a new third-party dependency in the shipped tree: `@modelcontextprotocol/sdk` already depends on it, and the THIRD-PARTY-NOTICES files are unchanged by this release. It is now declared directly by `platform-mcp-core` (`ajv: ^8.20.0`). `strict: false`, so the check is the meta-schema and nothing more: an unknown keyword, or a `required` naming an undeclared property, is not a defect, because no client refuses one. Format assertions are off for the same reason — an AI client never meta-validates the schema document (the MCP SDK's validator runs `validateSchema: false`), so a malformed `$id` or `$ref` costs a tool nothing and hiding it over one would be wrong. One format does decide a client's verdict, and it is checked directly beside the meta-schema: a `pattern` (or a `patternProperties` key) that is not a compilable regular expression. The meta-schema says only that it is a string, while a client COMPILES it — `ajv.compile` on `pattern: "["` throws, and the tool is dropped as silently as for any other defect. Tested with the `u` flag, which is how ajv compiles a pattern. A schema the validator itself cannot process is reported as having no defect — a validator fault is not evidence against a tool.

**A connected tool whose schema is invalid is not offered to agents (`platform-core-backend`).** When a server's tools are loaded, `ToolSchemaGuard` screens each input schema and the invalid ones are removed from the request client's tool repository. That repository is the single place `tools/list`, `list_tools`/`tools_info` and the TypeScript interfaces `call_tool_chain` generates are all built from, so one removal covers all three surfaces. The server's other tools are untouched. Nothing is rewritten to make a schema valid.

The check runs when a server's tools are loaded or refreshed: the verdict is remembered per distinct schema, so a tool call — which rebuilds the surface from those same unchanged schemas — costs a hash and a map lookup and never a re-check. A refresh that brings a corrected schema re-checks it, and the tool is offered again with the marker gone, without a restart. So does a refresh that brings NO tools for a server, whether because it dropped the offending tool or because it could not be reached at all: a load with nothing in it is what clears the marker, so nothing ever reports a defect this process can no longer see.

Findings are held per caller, because that is what a load is — discovery runs on the requesting user's own connection, and two callers can be shown different tools by one server. One caller's load therefore never erases another's finding, and the owner-facing surfaces read the union of what every caller's load has found, each distinct defect once. A caller's own loads are ordered against each other by a ticket taken before the tools are read, so two overlapping requests cannot put a marker back on a tool the later one saw corrected: the stale load still keeps the tool off its own surface, but it does not write what everyone reads.

An agent that calls a hidden tool by name is told the tool is hidden because its schema is invalid and that the people who manage its server can see why. The place and the reason are not in that answer: an agent can do nothing with them.

**The marker, for whoever manages the server.** One sentence, built once in mcp-core so the two surfaces cannot drift: `Hidden from agents: its schema is invalid at /required/0 (must be a string).`

- the tool page (`platform-core-frontend`) carries a `Not offered to assistants` section above the capabilities, naming each tool with its marker, and saying that the server's other tools are unaffected and that nothing is being rewritten;
- `list_tool_setup` reports the same findings per tool as `hiddenTools` (`name`, `path`, `reason`, `marker`), and `GET /api/tools/:slug` carries them as `hiddenTools` for the page.

Both are gated on the per-file write verdict — the same one that gates setting the tool's shared secrets. A caller who may only read the tool is told nothing: they cannot fix the schema, and the hidden tool is simply not among the ones they can call. The write check is only asked when there is something to show, so the healthy case costs no extra ACL round-trip.

**Hexis's own schemas are checked by tests**, so Hexis never ships what it hides another server's tool for: every tool def the five `register*Tools` functions produce, on both surfaces, plus the three code-mode meta-tools. The test checks itself too — it reads the server's own registration calls and fails if a tool module has been added there but not here, and fails if a module contributes no tools at all. A harness that silently skipped a module's schemas would be worse than no test, because it would read as if it had checked them.

## A limit worth knowing, upstream of all of this

At the ROOT of a tool's input schema, `type`, `properties` and `required` are the three fields `@modelcontextprotocol/sdk` models itself (`ToolSchema.inputSchema`, with `required: z.array(z.string())`), and its client rejects the ENTIRE `tools/list` response when one tool breaks them. A server sending `{"type":"object","properties":{},"required":[7]}` therefore costs its whole manual: Hexis is handed none of that server's tools, cannot hide one tool rather than all of them, and cannot name it in a marker. `@utcp/sdk`'s own `JsonSchemaSchema` rejects the same way for the keywords it models at any depth (`type`, `properties`, `items`, `required`, `additionalProperties`, `enum`, `format`, …), failing the manual rather than the tool.

So this change covers every invalid schema that reaches Hexis — which includes the shapes all three reported refusals had, all of them under keywords (`anyOf` and friends) that nothing between the server and Hexis models. For a root-level violation the behaviour is what it was before: the manual fails to register and the reason is logged. An e2e test pins that boundary so nobody has to rediscover it.

## For integrators

New in `@bevel-software/platform-mcp-core`: `inputSchemaDefect(schema)`, `schemaDefectMarker(defect)`, `SchemaDefect`.

New in `@bevel-software/platform-core-backend`:

- `shared/hidden-tools.js` — `HiddenTool`, `HiddenToolSource`.
- `modules/mcp/tool-schema-guard.js` — `ToolSchemaGuard`, `ScreenedTool`, `ScreenedHiddenTool`.
- `McpService.hiddenTools`, the read port the owner-facing surfaces use.
- `IToolManualService.setHiddenTools(source)`, wired from `createCoreServices`. Without it `getDetail` reports no hidden tool, which is the honest answer for a deployment with no MCP surface.
- `registerToolManualsTools`'s `deps` takes an optional `hiddenTools`.
- `ToolManualDetail.hiddenTools` is REQUIRED on the type: a host that builds a detail object by hand adds `hiddenTools: []`.
