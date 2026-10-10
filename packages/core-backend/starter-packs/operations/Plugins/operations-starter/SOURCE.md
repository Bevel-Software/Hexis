# Source

The skills in this plugin come from Anthropic's knowledge-work-plugins.

- Repository: https://github.com/anthropics/knowledge-work-plugins
- Commit: `ae1513ea94dcb74a7f1505ddcf3b0ec3fab327f1`
- Original plugin: `operations` (version 1.3.0)
- License: Apache License 2.0. The `operations` folder carries no copy of its own, so `LICENSE` beside this file is the repository's Apache-2.0 text as shipped in its other plugin folders.

Adapted for Hexis: converted from a Claude plugin (`.claude-plugin/plugin.json`, `.mcp.json`) to the Hexis plugin layout (`plugin.json`, `access.md`, `skills/<skill>/SKILL.md`); dropped the `.mcp.json` connector list (Slack, Google Calendar, Gmail, Notion, Atlassian, Asana) because each needs a third-party account and sign-in, and every skill's "If Connectors Available" section already treats them as optional; dropped `README.md` and `CONNECTORS.md`, which describe installing the plugin in Claude, and replaced each skill's pointer to `CONNECTORS.md` with a one-line note on what `~~category` names mean; "If knowledge base is connected" became "In the knowledge base", since in Hexis the knowledge base is always there; the slash-command usage blocks (`/runbook $ARGUMENTS`) became plain "ask for it by name" instructions, since Hexis serves skills rather than commands. The workflows, templates and wording are otherwise Anthropic's.
