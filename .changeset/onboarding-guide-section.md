---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': minor
---

Every knowledge base can onboard someone new through their agent, with nothing to install. The guide has a new `onboarding` section: the agent looks around first, welcomes the person by name with three things they can do here (ask, contribute, automate), each with an example from their own workspace, then does the one they pick with them and explains drafts, approval and tools at the moment they come up. The start section's table routes new people to it; the handshake text is unchanged. A distribution's guide hook may not drop or empty the section, since the prompt below points at it.

The hosted MCP endpoint also offers a platform prompt, `onboard`, beside the workspace's skills, so `/onboard` works in clients that show prompts as slash commands. It is offered only on a connection not narrowed to an agent (a narrowed one still serves its agent's skills and nothing beside them), and a skill named `onboard` replaces it. mcp-core exports `ONBOARD_PROMPT`, `ONBOARDING_GUIDE_SECTION_ID` and `promptsForSkills(skills, offerOnboard)`. The local `hexis-mcp` server does not offer the prompt yet: it cannot tell a narrowed key from one that connects as Everything.

The whole guide's budget rises to 23,000 tokens (the section is about 1,200).
