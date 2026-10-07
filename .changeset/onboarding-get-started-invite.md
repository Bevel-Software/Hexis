---
'@bevel-software/platform-core-frontend': minor
---

A "Get set up" checklist beside both apps, and an invite dialog for admins.

- The checklist sits to the right of Knowledge and Skills & Tools: create your workspace, connect your agent, read "How to get started", write your first page — and, for admins, choose where the knowledge lives, create a plugin for the team, and invite the team. Every step ticks itself off from what the app already knows (the onboarding flag, the file tree, the plugin catalog, the account list), so doing it anywhere counts. It is hidden on the welcome page and on screens of 1100px or narrower, and goes away once every step is done or it is closed.
- Admins get an Invite button in the toolbar, and the checklist's invite step opens the same dialog. Paste a list of addresses or type them one by one, choose Member or Admin, and each address gets an account waiting for that person's first single sign-on. The result says who was invited, who already had an account, and who could not be (a deployment with no seat left says so), and hands over the sign-in address and a message to forward.
- New optional registry slot `inviteExtras?: ComponentType<{ inviting: number }>`: a panel inside the invite dialog, rendered inside a boundary. A hosted deployment shows its seat meter and its "anyone at your domain can join" switch there; core renders nothing.
- `createAccount` now throws `AccountRequestError`, which carries the HTTP status alongside the message.
