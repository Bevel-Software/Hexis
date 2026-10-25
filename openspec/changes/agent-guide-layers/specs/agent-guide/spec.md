## ADDED Requirements

### Requirement: The first call returns the start section
`get_agent_guide` called without `section` SHALL return the `start-here` section as `guide`, and `sections` listing every section of the composed guide by id and title. `section: "all"` SHALL return the whole guide. Any other `section` SHALL return that section, or a refusal listing the ids.

#### Scenario: No section named
- **WHEN** an agent calls `get_agent_guide` with no arguments
- **THEN** `guide` is the `start-here` section, and `sections` names every section, the distribution's included

#### Scenario: The whole guide
- **WHEN** an agent calls `get_agent_guide` with `section: "all"`
- **THEN** `guide` is every section joined, the same text `read_file` on `AGENTS.md` serves after the organisation's own file

### Requirement: The start section names the default branch and maps the sections
`start-here` SHALL name the knowledge base's default branch as configured when the guide is composed, SHALL say that every file tool takes `branch`, and SHALL name every other core section with the question it answers.

#### Scenario: A renamed default branch
- **WHEN** the default branch is `production`
- **THEN** `start-here` names `production` and no other branch as the default

#### Scenario: A section without a route
- **WHEN** a core section is added and `start-here` does not name it
- **THEN** the guide check fails, naming the section

### Requirement: The guide stays within its budgets
The token count (o200k_base) of the platform part of the server instructions, the served tool list, `start-here`, each other section and the whole core guide SHALL stay within the budgets in design.md. Every core section SHALL have a budget.

#### Scenario: A section grows past its budget
- **WHEN** a section's text exceeds its budget
- **THEN** the budget test fails, naming the section, its count and its budget

#### Scenario: A new section has no budget
- **WHEN** a section is added without a budget entry
- **THEN** the budget test fails, naming it

### Requirement: The guide names only what the code has
Every tool, argument and result field named in the guide or the server instructions SHALL exist in the tool registry, unless declared in the test's list of non-tool words. Every call example SHALL use only arguments the tool takes and SHALL include every required one. Every platform folder and file name the guide states SHALL match `kb-layout.ts`, and no root folder name SHALL be written out where its placeholder belongs.

#### Scenario: A tool is renamed
- **WHEN** a tool the guide names no longer exists
- **THEN** the guide check fails, naming the tool and the section

#### Scenario: A call example misses a required argument
- **WHEN** the guide shows `read_file({ body: { path: "..." } })`
- **THEN** the guide check fails, naming `branch`

#### Scenario: A hard-coded root folder
- **WHEN** a section writes `KnowledgeBase/` instead of `{{knowledgeBaseDir}}/`
- **THEN** the guide check fails for a deployment that renamed the folder

### Requirement: A tool surface change is acknowledged
The names, arguments, required flags and enum values of the platform's own tools SHALL be recorded in a committed snapshot. A change to any of them SHALL fail the test suite until the snapshot is updated in the same change.

#### Scenario: An argument is added
- **WHEN** a tool gains an argument and the snapshot is not updated
- **THEN** the test fails with the difference and says to update the guide or accept the snapshot

### Requirement: The evaluation tasks stay answerable
For each evaluation task in design.md, `start-here` SHALL route it to at most two sections, those sections SHALL state each of its facts, and the routed sections with `start-here` SHALL fit within 6,000 tokens.

#### Scenario: A fact is removed
- **WHEN** an edit removes a fact an evaluation task relies on
- **THEN** the evaluation test fails, naming the task and the fact
