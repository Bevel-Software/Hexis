# Source

The skills in this plugin come from Anthropic's knowledge-work-plugins.

- Repository: https://github.com/anthropics/knowledge-work-plugins
- Commit: `ae1513ea94dcb74a7f1505ddcf3b0ec3fab327f1`
- Original plugin: `productivity` (version 1.3.1)
- License: Apache License 2.0, in `LICENSE` beside this file

Adapted for Hexis: converted from a Claude plugin (`.claude-plugin/plugin.json`, `.mcp.json`) to the Hexis plugin layout (`plugin.json`, `access.md`, `skills/<skill>/SKILL.md`); dropped the `.mcp.json` connector list (Slack, Notion, Asana, Linear, Atlassian, monday.com, ClickUp, Google Calendar, Gmail) because each needs a third-party account and sign-in; dropped `README.md` and `CONNECTORS.md`, which describe installing the plugin in Claude; dropped `skills/dashboard.html`, a local board that reads files from the agent's working directory in Claude Cowork and has no place to run from a shared knowledge base; renamed the `start` and `update` commands to the skills `productivity-start` and `productivity-update` so their names stay unique across a workspace's skills; the deep memory tier moved from a local `memory/` folder to the Hexis knowledge base (a Glossary page, People/ and Projects/ folders and a How we work page), with rules for what may go in a shared page (work facts only, ask before writing, update rather than duplicate) and personal preferences kept in the agent's own working-memory file; removed Cowork-specific instructions (`${CLAUDE_PLUGIN_ROOT}`, the Cowork VM note about opening files) and replaced "Claude" with "the agent" where it meant whichever agent runs the skill. The workflows, templates and wording are otherwise Anthropic's.
