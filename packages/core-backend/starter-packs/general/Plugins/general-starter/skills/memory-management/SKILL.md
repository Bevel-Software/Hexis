---
name: memory-management
description: Two-tier memory that makes the agent a true workplace collaborator. Decodes shorthand, acronyms, nicknames, and internal language so the agent understands requests like a colleague would. A small personal working-memory file for the hot cache, and the team's Hexis knowledge base (Glossary, People, Projects, How we work) for everything shared.
user-invocable: false
---

# Memory Management

Memory makes your agent a workplace collaborator - someone who speaks your internal language.

## The Goal

Transform shorthand into understanding:

```
User: "ask todd to do the PSR for oracle"
              ↓ the agent decodes
"Ask Todd Martinez (Finance lead) to prepare the Pipeline Status Report
 for the Oracle Systems deal ($2.3M, closing Q2)"
```

Without memory, that request is meaningless. With memory, the agent knows:
- **todd** → Todd Martinez, Finance lead, prefers Slack
- **PSR** → Pipeline Status Report (weekly sales doc)
- **oracle** → Oracle Systems deal, not the company

## Architecture

```
CLAUDE.md                ← Hot cache, personal (~30 people, common terms, your preferences)

Knowledge base (Hexis, shared with your team)
  Glossary.md            ← Full decoder ring (everything)
  People/                ← Work profiles of colleagues
  Projects/              ← Project details
  How we work.md         ← Teams, tools, processes
```

**CLAUDE.md (Hot Cache):** the file your agent reads at the start of every conversation, in its own working directory. Claude reads `CLAUDE.md`; other agents read their own file (often `AGENTS.md`). Use whichever your agent reads. It is NOT the `AGENTS.md` at the root of the knowledge base, which the platform maintains.
- Top ~30 people you interact with most
- ~30 most common acronyms/terms
- Active projects (5-15)
- Your preferences
- **Goal: Cover 90% of daily decoding needs**

**Glossary (Full Glossary):** the `Glossary` page in the knowledge base.
- Complete decoder ring - everyone, every term
- Searched when something isn't in CLAUDE.md
- Shared: the whole team benefits from every term anyone adds

**People/, Projects/, How we work:**
- Rich detail when needed for execution
- Full profiles, history, context

The knowledge base lives in the knowledge folder (`KnowledgeBase/` unless your workspace renamed it). Search it with the Hexis tools (`grep`, `find_node`, `read_file`) and write to it with `write_file` or `edit_file`. If the team already keeps these pages under other names, use theirs.

## Shared vs personal

The knowledge base is read by your whole team. Before anything goes there:

- **Work facts only.** Roles, responsibilities, how to reach someone for work, project facts, terms. Nothing private or personal about a colleague (no health, family, opinions of them, or hobbies they have not shared at work). Write each profile as if its subject will read it, because they may.
- **Your preferences stay personal.** "No meetings Friday afternoons" goes in CLAUDE.md, not the knowledge base.
- **Ask before writing.** Show what you will add and where. If the person cannot write to a page, the change goes in as a proposed change for the page's owner to approve; say so.
- **Check before adding.** Search the knowledge base first and update an existing page instead of creating a duplicate.

## Lookup Flow

```
User: "ask todd about the PSR for phoenix"

1. Check CLAUDE.md (hot cache)
   → Todd? ✓ Todd Martinez, Finance
   → PSR? ✓ Pipeline Status Report
   → Phoenix? ✓ DB migration project

2. If not found → search the knowledge base (Glossary first)
   → The full glossary has everyone/everything

3. If still not found → ask user
   → "What does X mean? I'll remember it."
```

This tiered approach keeps CLAUDE.md lean (~100 lines) while the knowledge base grows with the team.

## File Locations

- **Working memory:** `CLAUDE.md` (or your agent's equivalent) in the agent's working directory
- **Deep memory:** pages in the Hexis knowledge base

## Working Memory Format (CLAUDE.md)

Use tables for compactness. Target ~50-80 lines total.

```markdown
# Memory

## Me
[Name], [Role] on [Team]. [One sentence about what I do.]

## People
| Who | Role |
|-----|------|
| **Todd** | Todd Martinez, Finance lead |
| **Sarah** | Sarah Chen, Engineering (Platform) |
| **Greg** | Greg Wilson, Sales |
→ Full list: knowledge base Glossary, profiles: People/

## Terms
| Term | Meaning |
|------|---------|
| PSR | Pipeline Status Report |
| P0 | Drop everything priority |
| standup | Daily 9am sync |
→ Full glossary: knowledge base Glossary

## Projects
| Name | What |
|------|------|
| **Phoenix** | DB migration, Q2 launch |
| **Horizon** | Mobile app redesign |
→ Details: knowledge base Projects/

## Preferences
- 25-min meetings with buffers
- Async-first, Slack over email
- No meetings Friday afternoons
```

## Deep Memory Format (knowledge base)

**Glossary.md** - The decoder ring:
```markdown
# Glossary

Workplace shorthand, acronyms, and internal language.

## Acronyms
| Term | Meaning | Context |
|------|---------|---------|
| PSR | Pipeline Status Report | Weekly sales doc |
| OKR | Objectives & Key Results | Quarterly planning |
| P0/P1/P2 | Priority levels | P0 = drop everything |

## Internal Terms
| Term | Meaning |
|------|---------|
| standup | Daily 9am sync in #engineering |
| the migration | Project Phoenix database work |
| ship it | Deploy to production |
| escalate | Loop in leadership |

## Nicknames → Full Names
| Nickname | Person |
|----------|--------|
| Todd | Todd Martinez (Finance) |
| T | Also Todd Martinez |

## Project Codenames
| Codename | Project |
|----------|---------|
| Phoenix | Database migration |
| Horizon | New mobile app |
```

**People/{Name}.md:**
```markdown
# Todd Martinez

**Also known as:** Todd, T
**Role:** Finance Lead
**Team:** Finance
**Reports to:** CFO (Michael Chen)

## Working with Todd
- Prefers Slack DM
- Quick responses, very direct
- Best time: mornings

## Context
- Handles all PSRs and financial reporting
- Key contact for deal approvals over $500k
- Works closely with Sales on forecasting
```

**Projects/{Name}.md:**
```markdown
# Project Phoenix

**Codename:** Phoenix
**Also called:** "the migration"
**Status:** Active, launching Q2

## What It Is
Database migration from legacy Oracle to PostgreSQL.

## Key People
- Sarah - tech lead
- Todd - budget owner
- Greg - stakeholder (sales impact)

## Context
$1.2M budget, 6-month timeline. Critical path for Horizon project.
```

**How we work.md:**
```markdown
# How we work

## Tools & Systems
| Tool | Used for | Internal name |
|------|----------|---------------|
| Slack | Communication | - |
| Asana | Engineering tasks | - |
| Salesforce | CRM | "SF" or "the CRM" |
| Notion | Docs/wiki | - |

## Teams
| Team | What they do | Key people |
|------|--------------|------------|
| Platform | Infrastructure | Sarah (lead) |
| Finance | Money stuff | Todd (lead) |
| Sales | Revenue | Greg |

## Processes
| Process | What it means |
|---------|---------------|
| Weekly sync | Monday 10am all-hands |
| Ship review | Thursday deploy approval |
```

## How to Interact

### Decoding User Input (Tiered Lookup)

**Always** decode shorthand before acting on requests:

```
1. CLAUDE.md (hot cache)       → Check first, covers 90% of cases
2. Glossary (knowledge base)   → Full glossary if not in hot cache
3. People/, Projects/          → Rich detail when needed
4. Ask user                    → Unknown term? Learn it.
```

Example:
```
User: "ask todd to do the PSR for oracle"

CLAUDE.md lookup:
  "todd" → Todd Martinez, Finance ✓
  "PSR" → Pipeline Status Report ✓
  "oracle" → (not in hot cache)

Glossary lookup:
  "oracle" → Oracle Systems deal ($2.3M) ✓

Now the agent can act with full context.
```

### Adding Memory

When user says "remember this" or "X means Y":

1. **Glossary items** (acronyms, terms, shorthand):
   - Add to the Glossary page (after asking - it is shared)
   - If frequently used, add to CLAUDE.md Terms

2. **People:**
   - Create/update People/{Name}.md (work facts only)
   - Add to CLAUDE.md People if important
   - **Capture nicknames** - critical for decoding

3. **Projects:**
   - Create/update Projects/{Name}.md
   - Add to CLAUDE.md Projects if current
   - **Capture codenames** - "Phoenix", "the migration", etc.

4. **Preferences:** Add to CLAUDE.md Preferences section (personal, never the knowledge base)

### Recalling Memory

When user asks "who is X" or "what does X mean":

1. Check CLAUDE.md first
2. Search the knowledge base for full detail
3. If not found: "I don't know what X means yet. Can you tell me?"

### Progressive Disclosure

1. Load CLAUDE.md for quick parsing of any request
2. Read knowledge base pages when you need full context for execution
3. Example: drafting an email to todd about the PSR
   - CLAUDE.md tells you Todd = Todd Martinez, PSR = Pipeline Status Report
   - People/Todd Martinez.md tells you he prefers Slack, is direct

## Bootstrapping

Use `productivity-start` to initialize by scanning your chat, calendar, email, and documents. Extracts people, projects, and starts building the glossary.

## Conventions

- **Bold** terms in CLAUDE.md for scannability
- Keep CLAUDE.md under ~100 lines (the "hot 30" rule)
- Page names: readable, the way the team would look them up (`Todd Martinez.md`, `Project Phoenix.md`)
- Always capture nicknames and alternate names
- Glossary tables for easy lookup
- When something's used frequently, promote it to CLAUDE.md
- When something goes stale, drop it from CLAUDE.md; the knowledge base keeps it

## What Goes Where

| Type | CLAUDE.md (Hot Cache) | Knowledge base (shared) |
|------|----------------------|------------------------|
| Person | Top ~30 frequent contacts | Glossary + People/{Name}.md |
| Acronym/term | ~30 most common | Glossary (complete list) |
| Project | Active projects only | Glossary + Projects/{Name}.md |
| Nickname | In People if top 30 | Glossary (all nicknames) |
| Company context | Quick reference only | How we work |
| Preferences | All preferences | - |
| Historical/stale | ✗ Remove | ✓ Keep, marked as finished |

## Promotion / Demotion

**Promote to CLAUDE.md when:**
- You use a term/person frequently
- It's part of active work

**Drop from CLAUDE.md (the knowledge base keeps it) when:**
- Project completed
- Person no longer frequent contact
- Term rarely used

This keeps CLAUDE.md fresh and relevant.
