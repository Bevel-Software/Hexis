## Tools: when they are available, and what they need

**A tool becomes usable in three steps, in this order:**

1. **It is on `{{defaultBranch}}`.** Tools are served from the default branch
   only. An `mcp.json` entry or `.tool` file written on a draft is not listed,
   not callable and has no sign-in on the Connect page until it is merged. Check
   a draft with `list_tool_setup({ body: { branch: "<draft>" } })`:
   `onBranchOnly` names the new tools waiting there (a change to a tool that is
   already live is not listed). Tell the person it goes live once the change
   request is merged.
2. **Each person sets it up.** Where the tool needs a personal secret or a
   sign-in, each person sets theirs on the Connect page. A shared secret is set
   once, on the tool's page in the app, by someone who may edit the tool.
3. **The client lists the tools again.** The hosted endpoint reads the live
   catalog on every request but cannot tell a client it changed: most clients
   list again on their own, and one that keeps the list it got when it
   connected must reconnect. The local `hexis-mcp` server checks the catalog
   when its connection is used and tells the client; an idle connection catches
   up at its next use.

**A client connected with a connection key** (an automation, or an assistant
platform set up with a key) is served only the tools whose personal secrets
that key's person has already set. Set them first, then reconnect.

**When a tool is not working, call `list_tool_setup`**, then explain the
remaining steps rather than guessing. For each tool you can read:

- `setup.kind`, for an MCP server: `open` (no sign-in), `oauth-auto` (the
  platform registered itself with the service; people sign in on the Connect
  page) or `oauth-manual` (the sign-in needs an OAuth app its owner registers;
  see `tool-manuals`). `setup.reason` is there only while something blocks the
  sign-in, and says what to do. `setup` is null for a tool that is not an MCP
  server, or a server that sends its own `Authorization` header, runs locally,
  or could not be probed.
- Per variable: `scope` (`admin` = shared, `user` = personal),
  `adminConfigured` (the shared value, or the owner's sign-in setup, is done),
  `userConfigured` and `authorized` (your own value or sign-in).
- `canWrite`: whether you may edit the file that declares the tool, which is
  what lets someone set its shared secrets.

`invalid` lists the `.tool` files that were refused, and why. If a tool
disappears, check the person's read access to the file that declares it, then
`invalid`. An `mcp.json` server dropped for a bad declaration shows only in the
server's log: ask an admin.

**Who manages a tool** is whoever may write the file that declares it: the
`.tool` file itself (its own `write`/`owner` entries or its folder's
`access.md`), or, for an MCP server, the plugin's `access.md`. Not a platform
role. To hand a tool to someone, grant them `write` there.

**Agents never handle secret values.** Never ask for an API key, token or
client secret in the conversation; there is no tool to set one. Point the
person at the right place: shared values and OAuth client secrets are pasted on
the tool's page in the app by someone who may edit the tool; personal values
and sign-ins are entered on the Connect page by each person.

**Tools that only run on the person's machine** (a `.tool` with
`remote: false`, an MCP server with `local: true` or `type: "stdio"`) are not
on the hosted endpoint: `list_local_tools` names them. To use them, run the
knowledge base as a local MCP server, which serves everything the hosted one
does plus these:

```
npx @bevel-software/hexis-mcp --url <workspace-url> --key <connection-key>
```
