---
'@bevel-software/platform-core-backend': minor
---

Every workspace path resolves inside the repository, through one normaliser — nothing is ever written beside the checkout.

A workspace directory holds the repository checkout as one folder (`knowledge-base/` by default). The HTTP routes took paths relative to the WORKSPACE, so a caller who sent `KnowledgeBase/Report.md` instead of `knowledge-base/KnowledgeBase/Report.md` had its folder created, its file uploaded or its page written **beside** the repository — a location git never sees, so the content was never committed, never pushed and never shared, and it sat there until someone looked at the host. The access check on those routes had judged the path as if it were inside the repository and approved it, so what was checked was not what was written. The MCP tools refused such a path outright, with a message that even named the corrected spelling; the two behaviours had drifted, and a staging-test run left a `KnowledgeBase/` folder, a `Plugins/` folder and eight uploaded documents beside a checkout to prove it.

There is now ONE normaliser for every workspace path the platform accepts, routes and tools alike, and it puts every path inside the checkout. A path already under `knowledge-base/` is unchanged (the root-anchored `/knowledge-base/…` form the app's Copy path gives included); any other path is placed under it, so `KnowledgeBase/Report.md` means the page of that name in the repository. Repeated slashes and a leading `./` are collapsed, because one file must have one identity for the write turns and the lock rows to coordinate on. `.` or `..` segments, backslashes and absolute paths are still refused, with the message and the corrected path they always carried — those are attempts to leave the repository, not spellings of a path inside it, and a normaliser that "fixed" them would launder a traversal into a write.

After normalisation the resolved location is checked against `<workspace>/<kbDirName>`, and a miss is refused rather than written — so a spelling that normalises inside and resolves outside (through a symbolic link, say) is caught before any byte lands. Every access decision is made on the same normalised repository path the operation then uses.

**The MCP tools change behaviour**: a path they refused yesterday is accepted today and placed in the repository, and their answers name the path they used, so a caller always learns where its bytes went. Their descriptions say so. A script that was silently writing beside the checkout now writes into it; both are the intended outcome.

A root folder named exactly after the checkout folder is reserved — `knowledge-base/x` has to mean one thing, so a repository folder called `knowledge-base` would be unreachable. Creating, moving to or renaming to that name is refused, and the refusal says why. A namesake deeper in the tree is ordinary content.

Because strays already exist on running deployments, every start names whatever it finds in a workspace directory other than the checkout, in one boot note per workspace (`Beside the checkout, not in the repository: …`) — files and folders alike. Nothing is deleted and nothing is moved: the platform cannot prove it wrote any of it, and an operator who has looked is the one to clean up. The note stops on the next start after they do.
