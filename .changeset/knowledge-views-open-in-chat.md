---
'@bevel-software/hexis-mcp': minor
---

Knowledge views now open inside the chat. Every HTML knowledge view a person can read (a page made with the html-knowledge-view skill) becomes a tool of its own on the local hexis-mcp server, `show_<name>`, and an MCP Apps host renders the page in the conversation with live data from the knowledge base. In an inline or narrow frame the view shows a compact list built from the board's own definition; fullscreen shows the page as written. Links in the page open in the Hexis web app, and the page's "copy changes" sends the changes to the chat instead of the clipboard. The list of views and each page are kept under `~/.hexis/views`, readable only by their owner, so a restart serves them at once and refreshes in the background. The views sit beside the deployment's own `open_page` view and never share an address with it.
