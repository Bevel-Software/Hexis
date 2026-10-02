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

**The check.** Before anything is sent or run, a call's arguments are checked against the tool's input schema — on the direct tool-call path and inside `call_tool_chain`. A mismatch is a 400 with kind `arguments-do-not-match`, and the message says the arguments do not match, names each mismatch (a required argument that is missing, an argument the tool does not have, a value of the wrong type), then gives the tool's interface and the call example. A call whose arguments were wrapped in a `body` the tool does not have is told that its arguments go at the top level. A call that matches is passed on with exactly the arguments it was given; nothing is added, removed or rewritten. A schema the checker cannot reason about (a combinator, a `$ref`, a schema that is not an object) switches the check off for that tool, with one log line, and the call goes through as before. A missing `branch` keeps its own `branch-required` refusal.

**No GET sends a body.** A tool whose HTTP method is GET is now called with a `body_field` no argument can carry, whoever registered it, so it can never send a request body; an argument named `body` travels as a query parameter like any other.

**A page is not an answer.** A response that is not JSON where JSON was expected now reaches the agent as a short error with the status, the host and the first 200 characters, instead of the whole page.

A deployment that builds on Hexis gets all of this for the tools it adds without writing code for it: the guards are installed where a manual is registered.

New, exported from `@bevel-software/platform-mcp-core`:
- `callExample`, `callLine`, `exampleArguments`, `withCallExample`, `splitCallLine`, `describeInterface`, `argumentsDoNotMatchMessage`, `compileCheck`, `CALL_LINE_PREFIX`, `BODY_AT_TOP_LEVEL_LINE`, `ARGUMENTS_DO_NOT_MATCH_KIND`;
- `installCallGuards`, `argumentRefusal`, `ArgumentsDoNotMatchError`;
- `installGetHasNoBody`, `withoutBodyOnGet`, `NO_BODY_FIELD`;
- `pageInsteadOfJson`, `NOT_JSON_KIND`.

Changed:
- `toolDef` declares the `body` envelope required only when something inside it is, so a tool whose inputs are all optional is still called as `Bevel.<name>({})`.
- `prefixToolDescription` keeps a leading `Call:` line first.
- `PLATFORM_HEADER` and the description of `call_tool_chain` no longer state one calling shape for all tools; they point at each tool's `Call:` line.
- `TOOL_DESCRIPTION_CAP` caps what one tool's description may cost a client, the call example included.
