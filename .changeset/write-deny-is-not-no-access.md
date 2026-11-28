---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The Manage access dialog no longer labels a person denied one verb as "No access" while they can still read. The access view reports, for each person a deny on the target names, the verbs the resolver still lets them use there (`holds`), so a role member denied edit who reads through the role shows "Can read". The row names the verbs it is denied beside what it holds ("edit denied"). Those verdicts disclose role and group memberships, so another person's are reported only to someone who may change the target's access; everyone sees their own.
