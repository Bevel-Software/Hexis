# Starter packs

After the first-run storage step, a new knowledge base's admin is asked
"What does your team do?". Each answer is one folder here: the pages and the
team plugin it adds to the knowledge base, in one commit on the default branch,
authored by the admin who chose it. "Skip, I'll start from scratch" adds
nothing. Either way the choice is recorded (the `starterPack` deployment
setting) and the question is not asked again.

The code is `src/modules/onboarding/` (`starter-packs.ts` reads and validates
the packs, `starter-pack.service.ts` applies one).

## Layout

```
<id>/
  pack.yaml
  KnowledgeBase/…          pages
  Plugins/<plugin-name>/…  a team plugin
  Skills/…                 shared skills (optional)
```

`pack.yaml`:

```yaml
id: sales                # the folder's name: lowercase letters, digits, hyphens
name: Sales              # the chip's label
description: One line about what the pack adds.
order: 2                 # chip order: engineering 1, sales 2, support 3, operations 4, general 99
firstPagePrompt: |       # replaces the generic "write your first page" request for this team
  Using our Hexis knowledge base, fill in …
suggestedPages: [About us, Customers, Pricing, Objections, Glossary]   # named in the agent's first-run note
```

A folder whose `pack.yaml` is missing or does not validate is skipped with a
warning in the log; the others are still offered. `none` is reserved for the
skip.

`KnowledgeBase/`, `Plugins/` and `Skills/` use the default layout's names and
are written under the names the deployment chose for those folders. Text files
may use the layout placeholders (`{{knowledgeBaseDir}}`, `{{skillsDir}}`,
`{{pluginsDir}}`). Anything else in a pack folder (like this README) is never
copied. Dot-files are never copied.

Pages are short tasks rather than finished documents: a heading, a line or two
of placeholders, and "Ask your agent: _…_". While a page still holds exactly
what the pack wrote it does not count as written, so the "Write your first
page" step and the agent's first-run note stay open until someone fills one in.

## Plugins

A plugin uses Hexis's normal plugin layout: `plugin.json` (optional; one is
written for the folder name when absent), `skills/<skill>/SKILL.md`, and the
licence and provenance of anything vendored (`LICENSE`, `SOURCE.md`) inside the
plugin folder, so they travel with the skills. Skill names must be unique
across all packs.

When the pack is applied, the plugin's `access.md` is the pack's own (if it
ships one) with the admin who applied it added under `read`, `write` and
`owner`, the way "Create a plugin" makes a plugin its creator's. Without one,
the admin gets the access.md "Create a plugin" writes. A plugin whose folder
(or manifest name) already exists in the knowledge base is left alone entirely.

## Applying

Only paths that do not exist yet are written, judged with every path's lock
held, so a pack never overwrites a page. All of it lands as one commit through
the platform's batch write (`LockingFilesystem.writeFiles`), under the write
rules of the default branch, which an admin passes.

## Your own packs

A distribution can offer its own set by pointing `STARTER_PACKS_DIR` at a
folder in this format. A folder with no valid pack in it means the question is
never asked.

## Vendored skills

Most packs carry skills adapted from open-source projects. Each plugin's
`SOURCE.md` names the repository, the commit and what was changed; its
`LICENSE` is the project's own. Both ship inside the plugin folder, so the
licence travels with the skills wherever the plugin is copied. (The generated
`THIRD-PARTY-NOTICES.md` covers npm dependencies only; vendored content is
attributed here, in the plugin.)

To refresh a plugin's skills from a newer upstream commit:

1. Clone the upstream repository outside this one, at the commit you want, and
   record it: `git clone --depth 1 <repo> /tmp/upstream && git -C /tmp/upstream rev-parse HEAD`.
2. Diff the upstream skills against the commit named in `SOURCE.md`
   (`git -C /tmp/upstream diff <old-sha> -- <skill folders>` after fetching the
   old commit) and carry the changes into the adapted files by hand. The
   adaptation notes in `SOURCE.md` say what was removed and why — keep it removed.
3. Copy the upstream `LICENSE` again if it changed, and update the commit and
   notes in `SOURCE.md`.
4. Check every `SKILL.md` still has `name` and `description` frontmatter, that
   skill names stay unique across all packs, and that nothing points at the
   upstream project's own install (paths into `~/.claude/skills/…`, its setup
   or binaries). Then run the backend's tests: the loader test reads every
   packaged pack.

Nothing here fetches at build or test time; the packs are files in the repository.
