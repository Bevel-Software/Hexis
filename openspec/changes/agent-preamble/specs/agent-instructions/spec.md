## ADDED Requirements

### Requirement: An MCP session carries instructions on the handshake
Every MCP session Hexis serves SHALL include an `instructions` string in its initialize result. The full composed text SHALL be inline in that response, so a client that honours the field can place it in the model's system prompt before the model acts. The model SHALL NOT need to call any tool or read any file to receive it. This applies to the hosted endpoint for interactive (OAuth and JWT) sessions and for connection-key sessions alike, and to the local `hexis-mcp` bridge when the deployment advertises the capability.

#### Scenario: Hosted session initialises
- **WHEN** an MCP client initialises a session against `/api/mcp`
- **THEN** the initialize result carries `instructions`, and `Client.getInstructions()` returns the composed text

#### Scenario: Text is inline, not a reference
- **WHEN** the initialize result is inspected
- **THEN** `instructions` contains the header and the preamble content themselves, never a path, a tool name to call, or a link to fetch them

#### Scenario: Local bridge session initialises
- **WHEN** an MCP client initialises a session against a running `hexis-mcp` process connected to a deployment whose `/api/config` carries `agentInstructions: true`
- **THEN** the initialize result carries the same composed text the hosted endpoint would send

#### Scenario: Local bridge against an older deployment
- **WHEN** `hexis-mcp` starts against a deployment whose `/api/config` has no `agentInstructions` field
- **THEN** the bridge does not call the instructions endpoint, logs one line naming the older deployment, sends no `instructions`, and otherwise serves the session as before

#### Scenario: Local bridge cannot fetch the text
- **WHEN** the deployment advertises the capability but the instructions request fails, answers a non-2xx status, or answers a body without an `instructions` string
- **THEN** the bridge logs the failure, starts without `instructions`, and otherwise serves the session as before

### Requirement: The four knowledge-base tools carry a purpose prefix
The hosted `tools/list` SHALL prepend a prefix to the descriptions of exactly `start_session`, `grep`, `list_files` and `read_file`: the prefix, a blank line, then the tool's original description. The prefix SHALL be the fixed line "This organisation's knowledge base. Search it before answering from memory." followed, when the preamble has one, by the preamble's first paragraph that is not a markdown heading, the whole prefix capped at 300 characters on a code-point boundary. Every other listed tool's description SHALL be unchanged. The local bridge discovers its tools from the hosted listing and SHALL pass the prefixed descriptions through.

#### Scenario: Preamble present
- **WHEN** `mcp-description.md` has, after comment stripping, a first non-heading paragraph
- **THEN** each of the four descriptions starts with the fixed line, then that paragraph, and the prefix is at most 300 characters

#### Scenario: Preamble absent or heading-only
- **WHEN** the stripped preamble is empty or contains only headings
- **THEN** each of the four descriptions starts with the fixed line alone

#### Scenario: Other tools untouched
- **WHEN** `tools/list` is served
- **THEN** every tool other than the four, including the code-mode meta-tools, has the description it had before this change

#### Scenario: Connection-key session
- **WHEN** a connection-key session lists its tools after the per-credential filter
- **THEN** the four knowledge-base tools still carry the prefix

### Requirement: Instructions are composed from a platform header and the deployment preamble
The composed text SHALL consist of two parts, in order: a fixed platform header hard-coded in the platform, then the admin-edited deployment preamble (see `agent-preamble`) when it has one. The server SHALL inline the preamble's content into the text; it never sends a pointer to where the admin keeps it. The header SHALL state what Hexis is, that the knowledge base holds organisation-specific content not in the model's training data, that the model MUST search it (`start_session` once, then `grep`, `list_files` and `read_file`) before answering questions about the organisation, its people, customers, products, processes, projects or internal terms, that it MUST prefer what it finds there over memory or the web, and that skills are available as prompts and through `list_skills` and `get_skill`.

#### Scenario: Preamble present
- **WHEN** `mcp-description.md` on the default branch has non-empty content after comment stripping
- **THEN** the composed text is the header, a blank line, then that content

#### Scenario: Preamble absent or empty
- **WHEN** `mcp-description.md` is missing, empty, or contains only whitespace and HTML comments
- **THEN** the composed text is the header alone

#### Scenario: HTML comments are private notes
- **WHEN** `mcp-description.md` contains `<!-- ... -->` blocks
- **THEN** those blocks are removed from the composed text and from the tool prefix, so an admin can keep guidance to themselves inside the file

#### Scenario: An unterminated comment never leaks
- **WHEN** `mcp-description.md` contains a `<!--` with no closing `-->`
- **THEN** everything from that `<!--` to the end of the file is removed from the composed text and the tool prefix, and the composer reports `unterminatedComment: true`

### Requirement: The deployment preamble is capped
The preamble contribution SHALL be limited to 6,000 characters after comment stripping. Text beyond the cap SHALL be dropped on a code-point boundary and replaced by a one-line marker that names the cap and the file to edit. The character count reported SHALL be the count before truncation.

#### Scenario: Preamble within the cap
- **WHEN** the stripped preamble is 6,000 characters or fewer
- **THEN** it is sent whole and no marker is added

#### Scenario: Preamble over the cap
- **WHEN** the stripped preamble exceeds 6,000 characters
- **THEN** the first 6,000 characters are sent followed by a line such as `[preamble truncated at 6,000 characters; shorten mcp-description.md]`

#### Scenario: The cut lands inside a multi-byte character
- **WHEN** the 6,000th or 300th UTF-16 unit is the first half of a surrogate pair
- **THEN** the cut moves before that character, so no broken character is sent

### Requirement: The preamble is read with platform privileges
The preamble SHALL be read from the default-branch workspace at `${kbDirName}/mcp-description.md` by the platform, not as the calling user. Every connected agent receives the same composed text regardless of the caller's access to the repository root. The composed text SHALL NOT include anything else from the repository. Only a missing file (ENOENT) SHALL count as "no preamble"; any other read error SHALL surface as a failure, never as an empty preamble.

#### Scenario: Caller cannot read the repository root
- **WHEN** a user whose access resolution denies reading the repository root initialises an MCP session
- **THEN** the initialize result still carries the full composed text

#### Scenario: Workspace not yet bootstrapped
- **WHEN** the default-branch workspace does not exist on disk when the preamble is first read
- **THEN** the reader creates it before reading, exactly as the plugin archive route does

#### Scenario: Disk fault
- **WHEN** reading the file fails with an error other than ENOENT
- **THEN** the reader throws, the route answers 500, and the caller's own fallback decides what to send

### Requirement: The composed text is served by an agent-facing endpoint
The backend SHALL serve the composed text at `GET /api/agent/instructions` under the same authentication the tool catalogue endpoint (`/api/agent/all-tools`) accepts. The response SHALL be JSON carrying `instructions`, `toolPrefix`, `truncated`, `preambleChars` and `unterminatedComment`, with `Cache-Control: no-store`. The local bridge and the frontend card SHALL read this endpoint. The hosted proxy SHALL call the composer in-process rather than this endpoint.

#### Scenario: Authenticated request
- **WHEN** a request carries a valid connection key, internal token or browser session token
- **THEN** the endpoint answers 200 with the composer's result and `Cache-Control: no-store`

#### Scenario: Unauthenticated request
- **WHEN** a request carries no credential or an invalid one
- **THEN** the endpoint answers the same way `/api/agent/all-tools` does for that credential

### Requirement: The deployment advertises the capability
`GET /api/config` SHALL carry `agentInstructions: true` on every deployment that serves the instructions endpoint. A bridge SHALL treat the field's absence as an older deployment.

#### Scenario: Config read by the bridge
- **WHEN** `hexis-mcp` reads `/api/config` at startup
- **THEN** it learns the MCP endpoint and whether instructions are available from that one response

### Requirement: Instructions are computed at session start and never block a session
The hosted proxy SHALL compose the text while creating a session, in-process, so an edit to `mcp-description.md` reaches the next session without a restart. A failure to read SHALL fall back to the platform header alone and the fixed prefix line, log the failure, and let the session initialise.

#### Scenario: Preamble edited between sessions
- **WHEN** an admin commits a change to `mcp-description.md` on the default branch and a client then initialises a new session
- **THEN** that session's instructions and tool prefix carry the new content

#### Scenario: Read fails during session creation
- **WHEN** the reader throws during session creation
- **THEN** the session initialises with the platform header as its instructions and the fixed line as its prefix, and a warning is logged
