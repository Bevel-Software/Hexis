## Skills (`{{skillsDir}}/<scope>/…/<skill>/SKILL.md`, or `{{pluginsDir}}/<Plugin>/skills/<skill>/SKILL.md`)

A skill is a folder holding a `SKILL.md` and whatever files it needs. Shared
skills live under `{{skillsDir}}/`, organised by ownership; a skill that
belongs to one plugin alone may live in that plugin's `skills/` folder. Skill
names are unique across the catalog. The frontmatter names the skill, says
when to use it, and may list tools and a version:

```yaml
---
name: weekly-newsletter
description: "Use when someone asks for the Friday newsletter: drafts it for review."
allowed-tools: [slack_post_message]
metadata:
  version: "1.4.0"
---
```

- **The frontmatter is YAML.** Quote a value that contains `: ` or starts
  with a special character, as above, or the description comes out empty and
  nobody finds the skill. Read it back with `get_skill` after writing.
- **`description` is how the skill is found**: agents load a skill when its
  description fits the task. Say when to use it, in the words people use.
- **`allowed-tools`** names the tools the skill uses: any of the platform's
  tools, a plugin's (as `<server>_<tool>`), and the client's own (`Bash`,
  `Read`, `Bash(git:*)`). The platform warns about a name it does not know,
  and enforces nothing.
- **`metadata.version`** (or a top-level `version`) is reported by
  `list_skills`; `get_skill` with `version` loads the skill as it was when it
  last declared that version. Other `metadata` keys are the author's notes.

The body is the instructions, in plain markdown.

**A skill on a draft is not live.** The app's skills page, the prompts and
`list_skills` without `branch` show only the released catalog, read from
`{{defaultBranch}}`, so a skill on a draft "doesn't exist" there until it is
merged. To try it, pass the draft: `list_skills({ body: { branch: "<draft>" } })`,
then `get_skill({ body: { name: "weekly-newsletter", branch: "<draft>" } })`.
A skill that differs from the released one comes back with `unmerged: true`,
and its body opens with a line saying it is not approved. Once merged, it is
in the next `list_skills` or `get_skill`; a client that cached the prompt list
when it connected must reconnect to show it as a prompt.

Before offering to change a skill, read its `canWrite` (see `access-control`):
`list_skills` judges the `SKILL.md`, `get_skill` every file of the skill (or,
with `file`, that file alone).

**How skills reach agents.** Through this server (prompts, `list_skills`,
`get_skill`), or as native plugins: each person can install a plugin
marketplace from the app's external agent page, compiled from exactly the
skills they may read.

### A skill that needs tools checks them first

A skill that calls another service fails for anyone who has not signed in, or
before the tool is merged. Make its first step a check, and stop with a plain
instruction rather than a failed call:

```markdown
## Before you start
Call `list_tool_setup`. Find the Jira tool. If a variable with `scope: user`
shows `userConfigured: false` (or `authorized: false` for a sign-in), stop and
say: "Open the Connect page in <app> and sign in to Jira, then ask me again."
If the tool is missing altogether, say it is not available to them yet and who
to ask.
```

### A guided skill for people who are not technical

When a skill is for someone who is not an engineer, such as turning an idea
into a ticket, write it to lead them:

- **One question per message**, the most important first. Never a list of
  five.
- **Propose, then ask them to confirm.** "I would call it 'Search: filter by
  date'. Is that right?" is easier to answer than "What is the title?".
- **A checklist for "specified enough"** in the skill (who it is for, what
  should happen, how we know it works), and stop asking once it is met.
- **Plain words.** No platform terms (branch, change request, frontmatter,
  tool names); show the result in their language before you create anything.
- **Check its tools first** (above), so the conversation does not end in an
  error after ten questions.
