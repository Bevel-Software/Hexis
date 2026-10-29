## If you know Git

The platform keeps its files in a Git repository, but the people you work with
never touch Git, and neither do you: you have no git command. Use the
platform's own words. What carries over, and what does not:

| | Git and a code host | Here |
|---|---|---|
| Branches | Anyone branches anything | The default branch, `{{defaultBranch}}`, and any other protected branch are live. Work in progress goes on a draft branch named `<you>/<topic>` (see `drafts-and-change-requests`) |
| Commits | `git commit`, then `git push` | Every save is committed and shared as the person, moments after the call returns. No separate push |
| Pull requests | Opened and merged on the code host | A change request: you open it (`open_change_request`), a person reviews, approves and merges it in the app. No agent tool approves or merges one |
| Who approves | Code owners, branch rules | The owners and writers of each file the request changes |
| Permissions | The whole repository, read or write | Per folder and per file: `access.md` files say who may read, write, download or own. What you cannot read you cannot see or change, on any branch |
| Layout | Free | Free under `{{knowledgeBaseDir}}/`; `{{skillsDir}}/` and `{{pluginsDir}}/` have a layout the platform reads |
| Skills and tools | Files like any other | Live only once on `{{defaultBranch}}`; on a draft they wait for review |

**On your draft you can do anything to what you can read.** Create, edit, move
or delete any file you can read (a few platform files aside, see
`working-with-files`). Nobody else sees it until the draft is merged. Merging
is where the owners of the files approve, so a delete on your draft deletes
for everyone only once they accept it.

**On a protected branch, write access is checked per file.** If you may write
every file a change touches, it lands directly; ask the person first. If not,
the write is refused, and the refusal says how to propose it instead.

**An example.** A team keeps its specs in `{{knowledgeBaseDir}}/Products/Search/`,
whose `access.md` is:

```yaml
---
owner:
  - role/Admin
---
read:
  - everyone
write:
  - group/Search Team
```

The part above the second `---` says who may change this `access.md`; the
part below it is the folder's rules. Everyone signed in can read the specs.
Members of the group `Search Team` change them directly on `{{defaultBranch}}`.
Anyone else drafts the change on a branch and opens a change request, which a
member of `Search Team` approves. A folder inside it can narrow or widen this
with an `access.md` of its own. The full rules are in `access-control`.
