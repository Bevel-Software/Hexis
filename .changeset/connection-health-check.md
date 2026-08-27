---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Tool connection status now reports whether a credential **works**, not just whether one is stored. Until now every status came from the Secrets Vault, which can only say a value is present — so a mistyped API key rendered as **Connected** while the tool was silently dropped from the agent's toolset, with the rejection visible only in server logs.

Saving a key now probes the provider and keeps the verdict, and a **Test connection** button re-runs it on demand. Three states replace the old two: **Connected** (a real call succeeded, with the time it was checked on hover), **Key saved** / **Signed in** / **No key needed** (in place, nothing has tested it), and **Not working** (the provider rejected it, quoting what it said). `Connected` is now the only word that asserts a working connection, and it is never shown without evidence.

A remote MCP server is tested by its authenticated handshake, so it needs no configuration. `http` and `inline` manuals have no equivalent moment — registering an `http` manual fetches its usually-public description — so they can declare a cheap read-only endpoint to probe:

```yaml
healthCheck:
  url: https://api.example.com/v1/me
```

Headers default to the manual's own, so the probe carries the same credential a real call would. Without a declaration the tool reports as unverified rather than claiming to work. Only a definitive rejection (401/403) is reported as **Not working**; a timeout, a 5xx, or an unreachable host reports as unverified, so an outage elsewhere never accuses the user's key.
