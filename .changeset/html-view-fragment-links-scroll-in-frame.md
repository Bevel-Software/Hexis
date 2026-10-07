---
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-core-backend': minor
---

A fragment link inside a live HTML page scrolls the page, and the agent guide has a section on HTML views.

- In an `.html` page, a click on `<a href="#totals">` scrolls the element with that id into view inside the frame. Before, the browser resolved the fragment against the app's URL and navigated the frame away, leaving it blank. `window.bevel.openNode('#totals')` and `window.bevel.navigate('#totals')` do the same, instead of re-opening the file with the fragment on the app's URL. A fragment naming no element does nothing; `#` and `#top` with no such element scroll to the top. A link to another document with a fragment (`../Knowledge/Alice.md#goal`) still opens that document.
- The served agent guide (`get_agent_guide`, and `read_file` of `AGENTS.md` at the repository root) has a new `html-views` section, after `tool-manuals`: the frame's limits, the `window.bevel` members core exposes (`openNode`, `navigate`), which links written in the markup survive and how every link resolves. A distribution's agent-guide hook may replace that section with its own (for example one naming the data members it adds to `window.bevel`) or drop it.
