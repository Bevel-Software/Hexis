---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-frontend': minor
---

Connected MCP servers and drafts:

- A connected MCP server's failure now fails the call:
  - An answer with `isError: true` fails the call. `@utcp/mcp` dropped the flag, so the call read as a success whose text was the error; the proxy now passes the server's own text on, marked `isError`, and a chain sees a rejected call. The hosted surface and `hexis-mcp` both install this.
  - Such an answer is never taken for a rejected token: its words can say "401" or "Unauthorized" without a token refresh, a retry or a disconnected sign-in.
  - Its words are passed on with every credential the call carried taken out: each value substituted into the server's template when it registered, recorded as the substitutor resolves it, and every credential-named header, query parameter, environment variable or auth field spelled out in full. So a server that echoes a shared key does not hand it to the caller. The same holds for every failure of such a call, a thrown JSON-RPC error or an HTTP error body included, and for a failed registration.
  - What the caller sent in the call's arguments (a string, a key or a number of four characters or more, as sent or JSON- or url-escaped) is taken out too, in any piece of four characters and case aside, whether or not it matched a secret, so the answer is the same whether a guess at a key was right or wrong. The names and values the tool's own input schema declares are not the caller's text.
  - A failure's binary payloads (image, audio, a resource's blob) are not passed on, and an answer whose redaction would compare or read too much (a million characters compared, four million read of the arguments) is replaced by `[redacted]` entirely.
- `registerManual` refuses a server whose substituted value contains `$NAME` or `${NAME}`: every call would read it as another variable. The refusal names the variable, not the value.
- `SecretRedactor`, the connection probe's redactor, is now `platform-mcp-core`'s and serves both. A known credential (`remember`) is taken out wherever it appears, whatever its length; a substituted value (`rememberSubstituted`, new) is one too when its variable's name marks it as one, and otherwise a short one only where it stands alone. It takes out masked heads, overlapping echoes, and a value's trimmed, url-encoded and JSON-escaped spellings; it reads a credential query parameter the way `URLSearchParams` does, in both spellings; and it counts more names as credentials. A name is one when it contains `auth`, `key`, `token`, `secret`, `password`, `passwd`, `passcode`, `passphrase`, `pwd`, `cookie`, `credential`, `session`, `bearer`, `jwt`, `signature` or `hmac`, or has as a whole word (camelCase included) `sig`, `hash`, `pin`, `pat`, `otp`, `sid`, `pw`, `pass`, `cred` or `creds`. The probe also redacts a value that only the process environment supplies.
- A server in a plugin's `mcp.json` can leave tools out: `excludeTools: ["<tool>", ...]` on its entry in `plugin.json`'s Hexis extension, by the name the server lists them under. `registerManual` takes them off the client every time the server registers, a session recovery included, so they are not in `tools/list`, `list_tools` or the chain's interfaces, and a call to one by name, through the chain's tool bridge too, is refused. A malformed list keeps the server offline. Saving the server in the editor keeps the list.
- A routed call to a connected server reaches only a tool the request's surface still holds, so a tool hidden for an invalid schema can no longer be called by name through the chain's tool bridge.
- `create_branch` prefixes a bare draft name the caller could not delete with their own prefix (`<email-localpart>/`, or their `suggestions/` prefix when the address has no usable localpart), and answers the name it created. A protected name is not prefixed, so it is still refused. The branch switcher names a new draft by the same rule, and offers to delete a person's own `suggestions/` drafts.
