---
'@bevel-software/platform-core-frontend': minor
---

The toolbar has a search box: "Search pages, skills and tools", after the app switcher. It opens a palette that finds pages, skills, tools and plugins BY NAME, from anywhere in the app — and so does Ctrl+K (⌘K on a Mac), which is also how it is reached on a narrow window, where the box itself does not fit.

- **Pages** are the files the Knowledge explorer browses, read off the same tree it draws: `KnowledgeBase/` and the content folders beside it, never `Plugins/`, the checkout's own configuration files, a folder's `access.md` or dot-prefixed bookkeeping. Each row names its folder, and choosing one opens it on the branch on screen.
- **Skills & tools** are the Library's skills, tools and plugins, each with the plugin it lives in. They are fetched when the palette opens, not on page load — the skill and tool lists and the plugin index, not the gallery's per-skill frontmatter reads — and fetched again on each later open, behind the rows already shown, so something created a minute ago is findable. A row opens the item at its canonical URL, the same one its Library card opens.
- Matching is a case- and accent-insensitive substring of the name, ranked by where it lands: the start of the name, then the start of a word, then anywhere. At most eight rows per group; no match says so.
- The palette is a combobox driving a listbox: ↑/↓ move the highlight, Enter opens it, Escape closes the palette and hands focus back to where it was, and Tab leaves it from the search box. The shortcut is not taken while a modal dialog is up.

New in `modules/workspace/utils/fileTree`: `knowledgeFiles(tree, kbDirName)`, every file the Knowledge explorer browses, breadth-first. `suggestedPages` now shares its walk and is unchanged.
