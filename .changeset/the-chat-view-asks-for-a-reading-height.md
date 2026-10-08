---
'@bevel-software/platform-core-backend': patch
---

The page an agent opens in a chat gets room to be read. A host starts an MCP App view a few lines tall and grows it only when the view asks, so `open_page` rendered as a thin strip. Once the page is on screen the view now asks the host for a reading height (640 CSS pixels) with `ui/notifications/size-changed`; the page scrolls inside it. A notice or a refusal still takes no more room than its sentence.
