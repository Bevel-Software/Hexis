# Source

The skills in this plugin come from Anthropic's knowledge-work-plugins.

- Repository: https://github.com/anthropics/knowledge-work-plugins
- Commit: `ae1513ea94dcb74a7f1505ddcf3b0ec3fab327f1`
- Original plugin: `sales` (version 2.0.1)
- License: Apache License 2.0, in `LICENSE` beside this file

Adapted for Hexis: converted from a Claude plugin (`.claude-plugin/plugin.json`, `.mcp.json`) to the Hexis plugin layout (`plugin.json`, `access.md`, `skills/<skill>/SKILL.md`); dropped the `.mcp.json` connector list (Slack, HubSpot, Salesforce, Close, monday.com, Clay, ZoomInfo, Notion, Atlassian, Fireflies, Apollo, Outreach, Google Calendar, Gmail, Microsoft 365, Similarweb, Google Drive, Gong, Zoom, Otter.ai, Calendly, Lusha, Crunchbase) because each needs a third-party account and sign-in, and the skills already work with whatever tools are connected or with uploaded files; dropped `README.md` and `CONNECTORS.md`, which describe installing the plugin in Claude; renamed the `setup` skill to `sales-setup` so its name stays unique across a workspace's skills; org facts the skills ask for (ICP, qualification framework, routing rules) are now looked up in, and offered back to, the Hexis knowledge base instead of Claude project instructions; "Pages" (a Claude Cowork surface) became knowledge base pages, and the rendering rule no longer assumes Cowork's artifacts, Pages or Slides; references to the Claude org's admin settings now name the connector's own settings; the writing-voice summary goes to the agent's own instructions rather than the shared knowledge base; "guidance for Claude" became "guidance for the agent". The workflows, rules and wording are otherwise Anthropic's.
