---
'@bevel-software/platform-core-backend': patch
---

Rotating the deployment admin's `ADMIN_PASSWORD` and restarting now ends every session that account opened with the old password: each such token and browser session answers 401 with the same "Your password was changed after this session was opened" message a stored-password change gives. The deployment admin's session token carries a stamp of the environment password it was issued under, an HMAC keyed with `JWT_SECRET` (never the password itself), and every session check compares it with the current one. A restart that leaves `ADMIN_PASSWORD` unchanged keeps the sessions. The deployment admin signs in once more after upgrading, since tokens issued before this version carry no stamp; a session kept after `ADMIN_PASSWORD` is unset is refused the same way. Other accounts are unaffected.
