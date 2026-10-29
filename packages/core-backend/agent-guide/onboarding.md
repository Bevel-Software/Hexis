## Onboarding someone new

Use this when someone is new here or asks to be onboarded ("onboard me", "get
started", "what can I do here"). Give them one picture, let them choose what to
do, and explain each idea at the moment they meet it, while they do something
real. Write short messages in plain words, in their language, one question at a
time.

### 1. Look around first, and say nothing yet

The welcome uses real examples, so find them first. About eight calls; one
search and one read are enough for the examples.

- `read_file` on `{{kbDirName}}/mcp-description.md`: what this knowledge base
  holds. If it is still the commented-out template, it says nothing about this
  organisation; do not quote it.
- `list_files` on `{{kbDirName}}` and `{{kbDirName}}/{{knowledgeBaseDir}}`: the
  areas that exist.
- `list_skills`: what people here can use.
- If you know who the person is (most clients say who is signed in): `grep` for
  their name and email to find pages they own or that name them, and their
  drafts in `list_branches` (named `<you>/…`, see `drafts-and-change-requests`);
  `branch_status` shows what a draft changes.

### 2. Welcome, and offer three things

> Hi <first name>, welcome to Hexis.
>
> Hexis is <organisation>'s shared knowledge, and I, your agent, can read it
> and work in it. You can:
>
> 1. **Ask**: get answers from <organisation>'s knowledge, each with the page
>    it came from. *For example: <a real question one of their areas answers>*
> 2. **Contribute**: add or change pages. A teammate approves the change before
>    it goes live. *For example: <something waiting on them, or a page they
>    could improve>*
> 3. **Automate**: use skills, ready-made instructions I follow, and connect
>    tools. *For example: <a real skill from `list_skills`, in one line>*
>
> Which one are you interested in?

Every name in an example must come from a tool result in this conversation;
never invent one. With nothing about the person, use the organisation's
top-level areas and its first useful skill; without their name, say "Hi,
welcome to Hexis". Keep it under about 150 words. If their first message also
asks a question, answer it in two or three lines above the welcome. Then stop
and wait. An answer that is a question, not a number, is option 1.

### 3. Do the option they chose

Explain an idea only when they meet it, in a sentence or two, and point to the
section that has the rest.

**Ask.** Search, read what matches, and answer in a few lines, naming the page
each fact came from by its path. If the knowledge base has nothing on it, say
so and do not fill the gap from memory.
The first time, say how this works: you search when asked rather than reading
everything up front (`how-agents-find-things`).

**Contribute.** Agree the change, show it as old and new text, and write only
after a yes. It goes on a draft (`drafts-and-change-requests`):

- Their existing draft for this work, if it has one. If its change request goes
  into another draft rather than `{{defaultBranch}}`, approving it makes nothing
  live yet: say so.
- If what is already on that draft changes more than they likely meant (who
  owns a page, who may edit it), point it out and ask.
- Otherwise a new `<you>/<topic>` draft. Ask before writing to
  `{{defaultBranch}}`, even when you may.

Ask before opening a change request, then give its link: that is where they see
the change in the app. Say once that a person approves it in the app with
**Approve**, then **Apply changes**, and that you cannot do that for them. If a
write is refused, say who can approve there (`access-control`).

**Automate.** Name two or three skills in one line each, pick one with them,
load it with `get_skill` and run it together. Before a step that creates
something outside the knowledge base, show it and ask. If the skill needs a
tool, `tools` says what each person sets up and when it starts working. A
secret pasted into the chat is never repeated or used: say to enter it on the
Connect page instead and to replace the pasted one. To build a skill, see
`skills`.

### 4. Close

One line of what happened and what now waits on whom:

> ✓ Connected · ✓ <what they did> · ◻ <what waits on someone, by name>

Offer the other two options in one line. If they use an agent with a local
project (Claude Code, Cursor), ask once whether they want a line for its
`AGENTS.md` or `CLAUDE.md`, the only text that agent always reads, and give it
only on a yes:

> Before answering about <organisation>'s <areas>, search the Hexis connector
> and cite the page used.
