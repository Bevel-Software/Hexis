---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
---

Every tool description starts with a call example, and a call whose arguments do not match the tool is answered with the tool's interface.

Agents got tool calls wrong in two recurring ways, and the answers they got back did not help them correct the call. The platform's own tools take their arguments under a `body` object; a tool that calls another service takes them flat. An agent that wrapped a flat tool's arguments in `body` sent a GET with a body and got back an HTML error page from that service's edge, where a search result was expected. An agent that left out a required argument got whatever the endpoint made of the absence.

**The call example.** Every tool an agent can see now has a description whose first line is how that tool is called:

```
Call: KNOWLEDGE_BASE.read_file({ body: { branch: "...", path: "..." } })
Call: THIRD_PARTY.search({ query: "..." })
```

The line is generated from the tool's own input schema — the namespace this connection exposes, the tool's name, and its required arguments with a placeholder per type — never written by hand, so it cannot drift and no tool is without one: the platform's own tools, the tools a deployment adds, and the tools of every connected server alike. It leads the description even where the knowledge-base purpose prefix is also prepended, and it travels with `tools_info` too.

**The check.** Before anything is sent or run, a call's arguments are checked against the tool's input schema. A mismatch is a 400 with kind `arguments-do-not-match`, and the message says the arguments do not match, names each mismatch (a required argument that is missing, an argument the tool does not have, a value of the wrong type, a value outside what the schema allows — its `enum`/`const`, a string's length or `pattern`, a number's range, an array's length or items), then gives the tool's interface and the call example. A call whose arguments were wrapped in a `body` the tool does not have is told that its arguments go at the top level; a call that passed a `body` tool's arguments at the top level is told where they go. A call that matches is passed on with exactly the arguments it was given; nothing is added, removed or rewritten. A schema the checker cannot reason about (a combinator, a `$ref`, a schema that is not an object) switches the check off for that tool, with one log line, and the call goes through as before. On the platform's routes a call that names no `branch` keeps its own `branch-required` refusal, which says more; a connected tool that declares a `branch` of its own is held to it like any other argument. A tool may name further arguments it refuses itself (`refusesItself` on `toolDef`) so its own message stays the one a caller reads.

**The check lives where the tool lives.** A tool the platform or a deployment hosts as a route is checked in that route's tool handler (`toolHandler`), so every caller gets the same answer: an agent over MCP, a `call_tool_chain` chain, the in-process agent, and a script or runner calling `POST /api/agent/tools/<name>` with a connection key. On that last surface `write_file` without `content` and `move_file` without `dest` answered a 500, and `grep` without `pattern` answered 200 having matched every file; all three now answer the 400 with the interface and run nothing. The plugin creation routes behind `my_plugin` and `create_plugin` run the same check, and a route is found by the path it is hosted at, so a tool whose route does not end in its name is checked too. A tool with no route here — a connected server's, or an http tool that calls another service directly — is checked by the tool client the platform creates for the request, before the call leaves. The MCP layer holds no check and no error handling of its own: it forwards the call and returns what the route or the client answered.

**No GET sends a body.** A tool whose HTTP method is GET is now called with a `body_field` no argument can carry, whoever registered it, so it can never send a request body; an argument named `body` travels as a query parameter like any other.

**A page is not an answer.** A response that is not JSON where JSON was expected now reaches the agent as a short error with the status, the host and the first 200 characters, instead of the whole page.

A deployment that builds on Hexis gets all of this for the tools it adds without writing code for it: `toolDef` declares a tool's arguments to the check that its route runs, and the client's guards are installed where a manual is registered.

New, exported from `@bevel-software/platform-mcp-core`:
- `callExample`, `callLine`, `exampleArguments`, `withCallExample`, `splitCallLine`, `describeInterface`, `argumentsDoNotMatchMessage`, `compileCheck`, `checkFor`, `CALL_LINE_PREFIX`, `BODY_AT_TOP_LEVEL_LINE`, `ARGS_UNDER_BODY_LINE`, `ARGUMENTS_DO_NOT_MATCH_KIND`;
- `installCallGuards`, `argumentRefusal`, `ArgumentsDoNotMatchError`;
- `installGetHasNoBody`, `withoutBodyOnGet`, `NO_BODY_FIELD`;
- `isPlatformHostedUrl`, which decides both who is seeded the loopback bearer and which tools the client leaves to their own route;
- `pageInsteadOfJson`, `NOT_JSON_KIND`.

Changed:
- `toolDef` declares the `body` envelope required only when something inside it is, so a tool whose inputs are all optional is still called as `Bevel.<name>({})`; it also declares the tool's arguments for its route's check, and takes `refusesItself`.
- `toolHandler` checks the arguments of every route-hosted tool. New in `tool-helpers`: `declareRouteTool`, `routeToolSchemas`, `routeToolSchemasForRequest`, `routeToolName`, `bodyEnvelope`, `argumentsRefusal`.
- `branchProvided` answers, rather than throws, the question `assertBranchProvided` asks.
- `start_session` declares no arguments and forbids extras, so a call that passes a stray `branch` is now refused by name instead of ignoring it.
- `prefixToolDescription` keeps a leading `Call:` line first.
- `PLATFORM_HEADER` and the description of `call_tool_chain` no longer state one calling shape for all tools; they point at each tool's `Call:` line.
- `clientVisibleLength` and `firstSentenceEnd` count the `Call:` line, so `TOOL_DESCRIPTION_CAP` holds with the call example included; `guideFirstDescription` puts the guide-first sentence behind a leading `Call:` line.
- `write_file`, `write_files` and `apply_file_upload` keep their own `bad_mode` refusal for a mode that is not one of the three.
