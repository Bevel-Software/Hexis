---
'@bevel-software/platform-core-frontend': minor
---

A distribution can point the login page at its provider's legal pages. The registry takes three optional fields. `makerLink` says where the maker's name in "Hexis by Bevel" leads, on the login page, the first-run screen and the toolbar, instead of the maker's own site. A compact toolbar, whose app menu's trigger holds the name as text, now links it at the foot of that menu, so every page in the app has the link; `makerLinkLabel` names that menu entry ("Impressum" rather than "Hexis by Bevel"). `loginLinks` lists links shown under the sign-in card, on the login page only. The hosted cloud uses both: "Impressum" and "Privacy" under the card, as German law wants them easy to recognise on every page of a commercial service, and the maker's name leading to its Impressum. Without them, the login page shows no links and the maker's name leads to the maker's site, as before.

The login page also scrolls when the screen is too short for the sign-in card, such as a phone held sideways. Before, the top and bottom of the card were cut off with no way to reach them.
