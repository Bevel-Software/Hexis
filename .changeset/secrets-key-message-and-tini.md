---
'@bevel-software/platform-core-backend': patch
---

A wrong-length encryption key now fails boot naming `SECRETS_ENC_KEY` — the variable core deployments actually set — instead of `SHAREPOINT_TOKEN_ENC_KEY`, a leftover from the shared crypto primitive's enterprise origin (overlays bringing their own key can pass their variable's name). The key's length is now validated at boot, at the point where it is known which variable supplied it — so a legacy deployment still keying through `CONNECTOR_CONFIG_ENC_KEY` or `SHAREPOINT_TOKEN_ENC_KEY` is told to fix that variable, not one it never set. The vault's "no key configured" error names `SECRETS_ENC_KEY` too. And the image's tini registers as a child subreaper (`tini -s`), so running under compose's `init: true` no longer prints the PID-1 warning on every boot.
