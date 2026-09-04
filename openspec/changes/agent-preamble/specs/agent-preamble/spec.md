## ADDED Requirements

### Requirement: The deployment preamble is a file at the repository root
The admin-written part of the agent instructions SHALL be the file `mcp-description.md` at the root of the knowledge-base repository, read from the default branch. It is a plain markdown file with no required frontmatter or structure. Under the template's root access policy only admins can read and write it; a non-admin may propose a change through a change request only where an admin has granted read access to the repository root.

#### Scenario: Admin edits the file in the app
- **WHEN** an admin opens `mcp-description.md` on the default branch in the Knowledge editor and saves
- **THEN** the save commits like any other repository file, with history, and the next MCP session carries the new text

### Requirement: The file is seeded, never rewritten
The startup phase SHALL add `mcp-description.md` from the template to any protected branch that lacks it, and SHALL leave an existing `mcp-description.md` untouched. The template file SHALL be a single HTML comment whose first line says that removing the wrapper broadcasts the text, followed inside the same comment by the explanation that every connected agent reads the file at session start whatever its access, that the content should stay under 6,000 characters and its first paragraph under 300, and a starter skeleton the admin fills in.

#### Scenario: Fresh knowledge base
- **WHEN** a deployment seeds an empty remote or boots against a repository with no `mcp-description.md`
- **THEN** every protected branch gains the template `mcp-description.md` in the startup commit

#### Scenario: A never-edited file sends nothing of its own
- **WHEN** a session is created against a deployment whose `mcp-description.md` is still the template
- **THEN** the instructions are the header alone and the tool prefix is the fixed line alone

#### Scenario: Existing preamble survives a restart
- **WHEN** a repository already carries `mcp-description.md` and the server restarts
- **THEN** the file's content is unchanged after the startup phase

#### Scenario: Deliberately empty preamble
- **WHEN** an admin empties `mcp-description.md` to send the platform header alone
- **THEN** the startup phase does not restore the template content

### Requirement: The managed agent guide points at the preamble
This requirement covers only an agent working in a git clone of the repository with no MCP connection, which has no handshake to receive the text through. The managed root `AGENTS.md` SHALL tell such an agent to read `mcp-description.md` first for what the knowledge base contains and when to consult it, and SHALL say that agents connected over MCP receive the default branch's copy inline while a clone reads the copy on its own branch.

#### Scenario: Agent works in a direct clone
- **WHEN** an agent reads the managed `AGENTS.md` in a checkout of the repository
- **THEN** it finds a line directing it to `mcp-description.md` before the platform mechanics

### Requirement: The app shows what connected agents are told
The External agent access page SHALL show a section titled "What connected agents are told" containing two blocks: "On connect", the composed instructions as they would be sent with the preamble's character count against the 6,000 cap and the clients that read the handshake; and "On the four knowledge-base tools", the tool prefix as it will appear with its count against the 300 cap and the clients that read only descriptions. The section SHALL warn when either text is truncated and when a comment is left open, and SHALL state that every connected agent sees the text whatever its access. Admins SHALL see an Edit link that opens `mcp-description.md` on the default branch in the Knowledge editor, at `kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/mcp-description.md`)`, rendered only once `kbDirName` is known. Non-admins SHALL see the text read-only with a line saying admins edit it in `mcp-description.md` at the repository root. A failed fetch SHALL show an inline message and leave the rest of the page working.

#### Scenario: Admin views the page
- **WHEN** an admin opens External agent access
- **THEN** the section shows both blocks, counts such as `1,240 / 6,000 characters` and `212 / 300 characters`, and an Edit link to `mcp-description.md` on the default branch

#### Scenario: Non-admin views the page
- **WHEN** a non-admin opens External agent access
- **THEN** the section shows the same two blocks and counts, no Edit link, and the line saying admins edit the file

#### Scenario: Preamble over the cap
- **WHEN** the preamble exceeds 6,000 characters
- **THEN** the section shows the truncated text, the count over the cap, and a warning that agents receive only the first 6,000 characters

#### Scenario: Prefix over the cap
- **WHEN** the fixed line plus the first paragraph exceeds 300 characters
- **THEN** the section shows the cut prefix, the count over the cap, and a warning that the four tools receive only the first 300 characters

#### Scenario: Comment left open
- **WHEN** the file contains an unterminated `<!--`
- **THEN** the section warns that everything after it is withheld from agents and names the fix

#### Scenario: Workspace still loading
- **WHEN** an admin opens the page before the workspace has reported `kbDirName`
- **THEN** the section renders without the Edit link until it is known, and never renders a link with a missing segment

#### Scenario: Fetch fails
- **WHEN** the instructions request fails
- **THEN** the section shows an inline error and both tabs keep working
