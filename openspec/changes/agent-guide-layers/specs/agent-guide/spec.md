## ADDED Requirements

### Requirement: The first call returns the start section
`get_agent_guide` called without `section` SHALL return the `start-here` section as `guide`, and `sections` listing every section of the composed guide by id and title. `section: "all"` SHALL return the whole guide. Any other `section` SHALL return that section, or a refusal listing the ids.

#### Scenario: No section named
- **WHEN** an agent calls `get_agent_guide` with no arguments
- **THEN** `guide` is the `start-here` section, and `sections` names every section, the distribution's included

#### Scenario: The whole guide
- **WHEN** an agent calls `get_agent_guide` with `section: "all"`
- **THEN** `guide` is every section joined

#### Scenario: A read of AGENTS.md
- **WHEN** an agent reads `AGENTS.md` at the repository root
- **THEN** it gets the organisation's own file when there is one, then the `start-here` section and every section by id and title, not the whole guide

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

### Requirement: New people are pointed at the onboarding section
The guide SHALL have an `onboarding` section with the flow for welcoming someone new, and `start-here` SHALL route that question to it. The server instructions SHALL NOT repeat the routing: they tell an agent to read the guide first, and the guide's start is where the question is routed. A distribution's hook SHALL NOT drop or empty the section, since the platform's `onboard` prompt points at it by id.

#### Scenario: Someone says "onboard me"
- **WHEN** an agent reads the guide's start
- **THEN** its routing table sends "someone is new, asks what this is or what you can do for them, or asks to be onboarded" to the `onboarding` section

#### Scenario: A hook drops the section
- **WHEN** a distribution's hook returns the sections without `onboarding`, or with an empty one
- **THEN** composing the guide fails, naming the section and the prompt that points at it

#### Scenario: The section is fetched
- **WHEN** an agent calls `get_agent_guide` with `section: "onboarding"`
- **THEN** it gets the onboarding flow with the deployment's folder names and default branch filled in

### Requirement: The hosted endpoint offers a platform `onboard` prompt
On a connection not narrowed to an agent, the hosted MCP endpoint SHALL list a prompt named `onboard` first, beside the workspace's skills, and `prompts/get` for it SHALL return one message pointing at the `onboarding` section. A skill named `onboard` SHALL replace it. A connection narrowed to an agent SHALL list its agent's skills and nothing beside them. The local `hexis-mcp` server does not offer the prompt.

#### Scenario: A connection that is not narrowed
- **WHEN** a person's connection lists prompts
- **THEN** `onboard` comes first, and getting it returns a message to read the guide's `onboarding` section and follow it

#### Scenario: A workspace has its own onboarding
- **WHEN** a skill named `onboard` is released
- **THEN** the prompt list carries that skill under the name, and not the platform's prompt

#### Scenario: A connection narrowed to an agent
- **WHEN** a connection narrowed to an agent lists prompts or gets `onboard`
- **THEN** it lists only its agent's skills, and `onboard` answers "Unknown skill" unless the agent's skills include one of that name
