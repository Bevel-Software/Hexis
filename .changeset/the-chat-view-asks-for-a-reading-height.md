---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The page an agent opens in a chat gets room to be read, and its token lives an hour. A host starts an MCP App view a few lines tall and grows it only when the view asks, so `open_page` rendered as a thin strip; once the page is on screen the view now asks the host for a reading height (640 CSS pixels) with `ui/notifications/size-changed`, and the page scrolls inside it. A notice or a refusal still takes no more room than its sentence. The embed token, which rides in the tool result and so in the chat transcript, now expires after one hour instead of two: whoever holds it may read and edit that one file as the token's user only until then, and a view older than that shows the expired sentence so the agent opens the page again. The Atlassian panel's tokens shorten alike.
