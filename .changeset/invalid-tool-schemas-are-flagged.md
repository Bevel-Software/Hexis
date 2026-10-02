---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A connected tool's input schema reaches clients as its server sent it, and a tool whose schema really is invalid is hidden with a marker its owner can read.

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

**The proxy passes schemas through (`@bevel-software/platform-mcp-core`).** `sanitizeInputSchema` keeps its two deliberate transformations — inlining local `$ref` pointers and dropping non-standard `format` values, both of which exist because the Anthropic tool validator rejects a tool over them — and changes nothing else. Its guards no longer rewrite anything:

- a `$ref` that resolves back onto a schema already being inlined is recursive, and degrades to a permissive `{}` at that position, which is a schema position and therefore legal;
- the depth cap (now 200, and a stack guard rather than a schema rule) hands the rest of the subtree back exactly as it came.

A test pins the pass-through with a schema carrying `anyOf` lists, `required` lists and nested `items`, at 1, 5, 8, 12 and 30 levels of nesting.

**New: `inputSchemaDefect` and `schemaDefectMarker` (`@bevel-software/platform-mcp-core`).** The JSON Schema 2020-12 meta-schema check, via `ajv` — which is not a new third-party dependency in the shipped tree: `@modelcontextprotocol/sdk` already depends on it, and the THIRD-PARTY-NOTICES files are unchanged by this release. It is now declared directly by `platform-mcp-core` (`ajv: ^8.20.0`). `strict: false`, so the check is the meta-schema and nothing more: an unknown keyword, or a `required` naming an undeclared property, is not a defect, because no client refuses one. A schema the validator itself cannot process is reported as having no defect — a validator fault is not evidence against a tool.

**A connected tool whose schema is invalid is not offered to agents (`platform-core-backend`).** When a server's tools are loaded, `ToolSchemaGuard` screens each input schema and the invalid ones are removed from the request client's tool repository. That repository is the single place `tools/list`, `list_tools`/`tools_info` and the TypeScript interfaces `call_tool_chain` generates are all built from, so one removal covers all three surfaces. The server's other tools are untouched. Nothing is rewritten to make a schema valid.

The check runs when a server's tools are loaded or refreshed: the verdict is remembered per distinct schema, so a tool call — which rebuilds the surface from those same unchanged schemas — costs a hash and a map lookup and never a re-check. A refresh that brings a corrected schema re-checks it, and the tool is offered again with the marker gone, without a restart.

An agent that calls a hidden tool by name is told the tool is hidden because its schema is invalid and that the people who manage its server can see why. The place and the reason are not in that answer: an agent can do nothing with them.

**The marker, for whoever manages the server.** One sentence, built once in mcp-core so the two surfaces cannot drift: `Hidden from agents: its schema is invalid at /required/0 (must be a string).`

- the tool page (`platform-core-frontend`) carries a `Not offered to assistants` section above the capabilities, naming each tool with its marker, and saying that the server's other tools are unaffected and that nothing is being rewritten;
- `list_tool_setup` reports the same findings per tool as `hiddenTools` (`name`, `path`, `reason`, `marker`), and `GET /api/tools/:slug` carries them as `hiddenTools` for the page.

Both are gated on the per-file write verdict — the same one that gates setting the tool's shared secrets. A caller who may only read the tool is told nothing: they cannot fix the schema, and the hidden tool is simply not among the ones they can call. The write check is only asked when there is something to show, so the healthy case costs no extra ACL round-trip.

**Hexis's own schemas are checked by tests**, so Hexis never ships what it hides another server's tool for: every tool def the five `register*Tools` functions produce, on both surfaces, plus the three code-mode meta-tools.

## A limit worth knowing, upstream of all of this

At the ROOT of a tool's input schema, `type`, `properties` and `required` are the three fields `@modelcontextprotocol/sdk` models itself (`ToolSchema.inputSchema`, with `required: z.array(z.string())`), and its client rejects the ENTIRE `tools/list` response when one tool breaks them. A server sending `{"type":"object","properties":{},"required":[7]}` therefore costs its whole manual: Hexis is handed none of that server's tools, cannot hide one tool rather than all of them, and cannot name it in a marker. `@utcp/sdk`'s own `JsonSchemaSchema` rejects the same way for the keywords it models at any depth (`type`, `properties`, `items`, `required`, `additionalProperties`, `enum`, `format`, …), failing the manual rather than the tool.

So this change covers every invalid schema that reaches Hexis — which includes the shapes all three reported refusals had, all of them under keywords (`anyOf` and friends) that nothing between the server and Hexis models. For a root-level violation the behaviour is what it was before: the manual fails to register and the reason is logged. An e2e test pins that boundary so nobody has to rediscover it.

## For integrators

New in `@bevel-software/platform-mcp-core`: `inputSchemaDefect(schema)`, `schemaDefectMarker(defect)`, `SchemaDefect`.

New in `@bevel-software/platform-core-backend`:

- `shared/hidden-tools.js` — `HiddenTool`, `HiddenToolSource`.
- `modules/mcp/tool-schema-guard.js` — `ToolSchemaGuard`, `ScreenedTool`.
- `McpService.hiddenTools`, the read port the owner-facing surfaces use.
- `IToolManualService.setHiddenTools(source)`, wired from `createCoreServices`. Without it `getDetail` reports no hidden tool, which is the honest answer for a deployment with no MCP surface.
- `registerToolManualsTools`'s `deps` takes an optional `hiddenTools`.
- `ToolManualDetail.hiddenTools` is REQUIRED on the type: a host that builds a detail object by hand adds `hiddenTools: []`.
