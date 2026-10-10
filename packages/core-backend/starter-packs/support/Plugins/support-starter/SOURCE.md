# Source

The skills in this plugin come from Anthropic's knowledge-work-plugins.

- Repository: https://github.com/anthropics/knowledge-work-plugins
- Commit: `ae1513ea94dcb74a7f1505ddcf3b0ec3fab327f1`
- Original plugin: `customer-support` (version 1.3.0)
- License: Apache License 2.0, in `LICENSE` beside this file

Adapted for Hexis: converted from a Claude plugin (`.claude-plugin/plugin.json`, `.mcp.json`) to the Hexis plugin layout (`plugin.json`, `access.md`, `skills/<skill>/SKILL.md`); dropped the `.mcp.json` connector list (Slack, Intercom, HubSpot, Guru, Atlassian, Notion, Google Calendar, Gmail) because each needs a third-party account and sign-in, and the skills already say what to do when a source is not connected; dropped `README.md` and `CONNECTORS.md`, which describe installing the plugin in Claude, and replaced each skill's pointer to `CONNECTORS.md` with a one-line note on what `~~category` names mean; "knowledge base" now means this workspace's Hexis knowledge base (plus any other docs tool that is connected) rather than an optional connector; the slash-command usage lines (`/ticket-triage …`) became plain "ask for it by name" instructions, since Hexis serves skills rather than commands. The workflows, templates and wording are otherwise Anthropic's.
