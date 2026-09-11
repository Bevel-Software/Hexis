## ADDED Requirements

### Requirement: The deployment preamble is a file at the repository root
The admin-written part of the agent instructions SHALL be the file `mcp-description.md` at the root of the knowledge-base repository, read from the default branch. It is a plain markdown file with no required frontmatter or structure. Under the template's root access policy only admins can read and write it. The app SHALL expose the admin's part through the inline editor on External agent access rather than as an ordinary workspace-tree document.

#### Scenario: Admin edits the description in the app
- **WHEN** an admin edits and saves "Your description" on External agent access
- **THEN** the app writes `mcp-description.md` through the normal default-branch workspace save path, with history, and the next MCP session carries the new text

### Requirement: The file is seeded, never rewritten
The startup phase SHALL add `mcp-description.md` from the template to any protected branch that lacks it, and SHALL leave an existing `mcp-description.md` untouched. The template file SHALL be a single HTML comment whose first line says that removing the wrapper broadcasts the text, followed inside the same comment by the explanation that every connected agent reads the file at session start whatever its access, that the content should stay under 6,000 characters and its first paragraph under about 220 (the fixed purpose sentence and it together are cut at 300), and a starter skeleton the admin fills in. When the configured template lacks the file, the packaged template's copy SHALL be seeded instead, with one line logged, so a deployment with an older custom template does not fail its first boot after upgrading.

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

### Requirement: The backing file is hidden from workspace navigation
The template root `.bevelignore` SHALL list the root-anchored `/mcp-description.md`. On existing protected branches, startup SHALL append that rule under a platform-owned comment when the file carries none of these four: the anchored rule, an unanchored rule the operator wrote, an unanchored rule the platform wrote, or an explicit negation. An unanchored rule the PLATFORM wrote, meaning one directly under a platform-owned comment, SHALL instead be respelled in place to the anchored form, which is why it is not also appended: the earlier spelling also hides an ordinary knowledge page of that name anywhere in the tree. The frontend merged-tree hook SHALL also omit the exact `${kbDirName}/mcp-description.md` path so cached server trees and optimistic overlays cannot expose the control file. A nested file with the same basename SHALL remain visible.

#### Scenario: Existing knowledge base upgrades
- **WHEN** startup finds a root `.bevelignore` with no rule for `mcp-description.md`
- **THEN** it appends the platform-owned rule once, and a second startup makes no further change

#### Scenario: Operator explicitly negated the rule
- **WHEN** `.bevelignore` contains `!mcp-description.md`
- **THEN** startup preserves the negation and does not append a positive rule

#### Scenario: The platform's own unanchored rule is respelled
- **WHEN** `.bevelignore` carries the unanchored `mcp-description.md` directly under a platform-owned comment, as the release that shipped that spelling wrote it
- **THEN** startup rewrites that line as `/mcp-description.md`, leaves the comment where it is, appends nothing beside it, and a second startup makes no further change

#### Scenario: The operator's own unanchored rule is kept
- **WHEN** `.bevelignore` carries the unanchored `mcp-description.md` with no platform-owned comment above it
- **THEN** startup leaves the line alone and appends no anchored rule beside it, because the file is already hidden

#### Scenario: A stale or optimistic tree contains the control file
- **WHEN** the merged workspace tree contains `${kbDirName}/mcp-description.md`
- **THEN** the navigation omits that exact entry but retains a nested file named `mcp-description.md`

### Requirement: The managed agent guide points at the preamble
This requirement covers only an agent working in a git clone of the repository with no MCP connection, which has no handshake to receive the text through. The managed root `AGENTS.md` SHALL tell such an agent to read `mcp-description.md` first for what the knowledge base contains and when to consult it, and SHALL say that agents connected over MCP receive the default branch's copy inline while a clone reads the copy on its own branch.

#### Scenario: Agent works in a direct clone
- **WHEN** an agent reads the managed `AGENTS.md` in a checkout of the repository
- **THEN** it finds a line directing it to `mcp-description.md` before the platform mechanics

### Requirement: The app shows what connected agents are told
The External agent access page SHALL put its connection setup first in a card containing Your agent, Marketplaces and Autonomous agents. A separate peer card below it SHALL be titled "What agents are told about this knowledge base" and show the fixed platform message in a closed drawer (sent first, not editable) followed by "Your description": the preamble body as sent with its character count against the 6,000 cap, or an empty state saying agents get the platform message only. It SHALL omit the old "Short version" preview and repository implementation copy. The card SHALL warn when the preamble is truncated and when a comment is left open, and SHALL state that every connected agent sees the text whatever its repository access. A failed composed-preview fetch SHALL show an inline message and leave connection tabs and the admin editor working.

#### Scenario: Admin views the page
- **WHEN** an admin opens External agent access
- **THEN** connection setup appears first, the separate instructions card shows the platform drawer and description count such as `1,240 / 6,000 characters`, and an Edit description button is present without navigating to the backing file

#### Scenario: Non-admin views the page
- **WHEN** a non-admin opens External agent access
- **THEN** the instructions card shows the same read-only platform and description text with no Edit action and no repository implementation copy

#### Scenario: Preamble over the cap
- **WHEN** the preamble exceeds 6,000 characters
- **THEN** the section shows the truncated text, the count over the cap, and a warning that agents receive only the first 6,000 characters

#### Scenario: Comment left open
- **WHEN** the file contains an unterminated `<!--`
- **THEN** the section warns that everything after it is withheld from agents and names a fix the reader can reach: for an admin the editor on this page, which closes the comment on save even when the visible text is unchanged, and for a non-admin that an admin can do it here

#### Scenario: The tool-description channel is cutting the first paragraph
- **WHEN** the composed result reports the tool prefix as truncated
- **THEN** the section warns that the fixed line and the first paragraph are over that channel's cap TOGETHER, names the cap and the length, and names which clients are affected and which are not, so an admin can tell whether it matters to their deployment

#### Scenario: A precondition on a file the caller cannot read
- **WHEN** a save carries a precondition for a path the caller has no read permission on
- **THEN** the write route refuses with the same 403 the file route gives, before comparing anything, and a save WITHOUT a precondition is unaffected

#### Scenario: Workspace still loading
- **WHEN** an admin opens the page before the workspace has reported `kbDirName`
- **THEN** the section renders without the Edit action until it is known and never creates a save path with a missing segment

#### Scenario: Fetch fails
- **WHEN** the instructions request fails
- **THEN** the section shows an inline error, the connection tabs keep working, and an admin can still open the inline description editor

### Requirement: Admins edit the public description inline
When `isAdmin` is true and `kbDirName` is known, the card SHALL load `${kbDirName}/mcp-description.md` from the default-branch workspace and show only its agent-visible text in an inline textarea. A missing file SHALL open as an empty description, and nothing else SHALL: the file route reports 404 for an absent file alone and gives any other read failure its own status, so an unreadable file SHALL surface as an inline error rather than an empty editor. Saving SHALL use the normal workspace write route, retain all private HTML comments from the source, and refresh the composed preview. The save SHALL carry the loaded bytes as a precondition so a file changed since it loaded is refused rather than overwritten. The precondition SHALL be answered only to a caller who may READ the file, under the same gate the file route uses: its answer is a fact about content, write authorisation is checked later, and an ungated precondition would tell a caller whether a file they cannot see holds a guessed value. A save failure SHALL keep the editor and unsaved value open. Cancel SHALL discard the textarea value without writing. Non-admins SHALL have no inline edit action.

#### Scenario: Admin saves an inline edit
- **WHEN** an admin changes the inline description and selects Save description
- **THEN** the backing file is written on the default branch, the editor closes, and the refreshed read-only preview shows the saved description

#### Scenario: Private comments survive an inline edit
- **WHEN** the backing source contains one or more well-formed HTML comments and the admin replaces the public description
- **THEN** the textarea omits those comments and the saved file retains them before the replacement public text

#### Scenario: Unterminated private comment is repaired on save
- **WHEN** the source ends in an unterminated HTML comment and the admin saves a new public description
- **THEN** the save closes that private comment before the new public text so the new description is not accidentally withheld

#### Scenario: Backing file is missing
- **WHEN** the default-branch read answers 404 for `mcp-description.md`
- **THEN** the editor opens empty and Save creates the file through the normal workspace route

#### Scenario: Another admin saved while this editor was open
- **WHEN** the backing file no longer holds the text this editor loaded and the admin selects Save description
- **THEN** the write is refused, nothing is overwritten, and the card shows that the file changed and keeps the editor open with the unsaved value

#### Scenario: The backing file cannot be read
- **WHEN** the default-branch read fails for any reason other than the file being absent
- **THEN** the card shows that error inline and offers no empty editor over text it could not read

#### Scenario: Save fails
- **WHEN** the workspace write is refused or fails
- **THEN** the card shows the returned error and keeps the editor open with the unsaved value

#### Scenario: Cancel an edit
- **WHEN** an admin changes the textarea and selects Cancel
- **THEN** the editor closes without a workspace write
