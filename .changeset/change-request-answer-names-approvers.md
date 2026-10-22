---
'@bevel-software/platform-core-backend': patch
---

The agent's change-request answer names every approver. `open_change_request` lists, per changed path, the people who may approve it; an owner that `roles.yaml` names by email has no display name, and the answer showed that owner as an empty string while the merge-blocked reasons named the same person by email. Each approver is now named by display name, or by email when there is no name, and one with neither is left out — never a blank entry. The tool's output schema says the same.
