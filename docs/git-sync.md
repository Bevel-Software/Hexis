# Keeping Hexis in sync with your git host

Hexis serves every page, skill and tool from its own clone of the
knowledge-base repository. When a change lands on the git host **from
outside Hexis** — a developer pushes from their machine, a pull request is
completed in the host's UI, a pipeline writes a skill — that clone does not
know until something in Hexis touches the branch again.

`POST /api/sync/<branch>` closes that gap. Call it from an action, a webhook
or a pipeline step whenever a branch changes, and Hexis pulls that branch's
clone, tells open browsers and agents, and refreshes the skill, tool and
plugin catalogues, all within the request.

## 1. Set the sync secret

Pick a long random string and set it as `KB_SYNC_SECRET` (or on the setup
screen, under *Knowledge, skills & tools → Advanced → Sync secret*):

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Without a secret the endpoint only accepts an administrator's own session.

The setup screen shows the exact address to paste into a hook, with a copy
button, beside the secret. Once the deployment is running, the Deployment
page also shows what the last sync did and offers **Sync now**, which pulls
every branch with your own session — handy for proving the connection
before trusting the hook.

## 2. Call the endpoint

Sync the branch whose change made the call:

```
POST https://<your-hexis-host>/api/sync/<branch>
Authorization: Bearer <KB_SYNC_SECRET>
```

A branch with slashes works spelled either way: `/api/sync/ali/new-skill` or
`/api/sync/ali%2Fnew-skill`. The body, if any, is ignored.

For hosts that cannot put the branch in the URL, `POST /api/sync` reads it
from the body instead:

| Body | Effect |
| --- | --- |
| An Azure DevOps service-hook payload | The pushed branch, or a pull request's source and target |
| A GitHub, Gitea or GitLab push payload | The pushed branch |
| `{ "branches": ["main", "ali/new-skill"] }` | Just those |
| *(empty)* | Every branch Hexis has a clone of |

Anything Hexis does not recognise falls back to syncing everything, so a
webhook never fails because of its payload shape.

### Response

```json
{
  "status": "synced",
  "results": [
    { "branch": "main", "outcome": "updated", "from": "3f1c…", "to": "9be2…" }
  ],
  "changeRequests": { "closedDeletedBranch": 0 }
}
```

Other outcomes: `up-to-date` (origin had nothing new), `not-cloned` (Hexis
has no clone of that branch yet — it clones one the first time someone
opens it, so there is nothing to refresh), `conflict` and `error` (below).

| Status | Meaning | Retry? |
| --- | --- | --- |
| `200` | The branch is current | — |
| `409` | The branch has a **conflict** — commits made in Hexis contradict what landed on the host. Automatic recovery is queued; the body's `error` names the files. See §4 | Yes, later: `200` once recovery or a person has cleared it |
| `503` | The branch could not be pulled (host unreachable, credential refused), or no sync secret is configured | Yes |
| `401` | Missing or wrong credential | No |
| `400` | Not a branch name git accepts, or a body that is not JSON | No |

A `curl --fail` therefore fails exactly when Hexis is not in sync.

## 3. Wire it up

### GitHub Action

```yaml
name: Sync Hexis
on:
  push:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: >
          curl --fail -sS -X POST
          "${{ vars.HEXIS_URL }}/api/sync/${{ github.ref_name }}"
          -H "Authorization: Bearer ${{ secrets.HEXIS_SYNC_SECRET }}"
```

`github.ref_name` is the branch that was pushed. Store the secret as a
repository secret and the Hexis address as a repository variable.

### Azure DevOps pipeline step

For a pipeline that writes skills or knowledge into the repository:

```yaml
- script: >
    curl --fail -sS -X POST
    "$(HEXIS_URL)/api/sync/$(Build.SourceBranchName)"
    -H "Authorization: Bearer $(HEXIS_SYNC_SECRET)"
  displayName: Sync Hexis
```

Store `HEXIS_SYNC_SECRET` as a secret pipeline variable. Note that
`Build.SourceBranchName` is the last segment of the branch name; for slashed
branches use `$(Build.SourceBranch)` with `refs/heads/` stripped, or send the
payload form below.

### Azure DevOps service hook

*Project settings → Service hooks → Create subscription → Web Hooks.* A
service hook cannot template the URL, so it uses the payload form:

1. Trigger **Code pushed**. Filter to the knowledge-base repository; leave
   the branch filter empty to sync every push.
2. Action: URL `https://<your-hexis-host>/api/sync`. In **HTTP headers**
   enter `Authorization: Bearer <KB_SYNC_SECRET>`. Leave basic auth empty.
   Resource details, messages and detailed messages can all stay *All*.
3. Repeat with trigger **Pull request updated**, filter *Completed*, so a
   pull request finished in the ADO UI syncs its target branch and lets
   Hexis close a matching change request whose source branch was deleted.

Azure DevOps disables a subscription after repeated failures, so a branch
that keeps answering `409` deserves a look. The subscription's history shows
the same message Hexis shows on the branch.

### GitHub webhook (instead of an action)

*Settings → Webhooks → Add webhook.* Payload URL
`https://<your-hexis-host>/api/sync`, content type `application/json`,
**Secret** = `KB_SYNC_SECRET`, event *Just the push event*. A webhook cannot
send custom headers, so GitHub signs the body instead; Hexis verifies the
`X-Hub-Signature-256` header with the same secret.

### GitLab webhook

*Settings → Webhooks.* URL `https://<your-hexis-host>/api/sync`, **Secret
token** = `KB_SYNC_SECRET`, trigger *Push events*. GitLab sends the token in
`X-Gitlab-Token`.

### Anything else

Any caller that can send an HTTP request with a bearer header works:

```sh
curl --fail -X POST https://<your-hexis-host>/api/sync/main \
  -H "Authorization: Bearer $KB_SYNC_SECRET"
```

An administrator signed in to Hexis can also call it with their own session
token, which is handy while wiring a hook up.

## 4. When a sync reports a conflict

A conflict means the branch holds commits made in Hexis that contradict what
landed on the host — the same file edited in both places. The sync takes the
same road as any update in Hexis: first the deterministic part (a rebase that
keeps every local commit and stashes in-progress edits), and when that cannot
apply cleanly, the background recovery that Hexis already runs for a save
that could not be pushed. On an enterprise deployment that is the recovery
agent; it reconciles what it can without losing anyone's work.

Because none of that is finished at the moment the request is answered, the
sync reports the branch as a conflict, with status `409`:

> main is not in sync yet: Plugins/x/SKILL.md changed both in Hexis and on
> the git host. Recovery is queued; if this stays, open the files on main in
> Hexis, keep what you want, and save.

The same sentence appears in the sync response, in a banner on that branch
in Hexis (with each file as a link), and in the server log. A later call
answers `200` once recovery has landed the branch. If the banner stays,
recovery could not settle it without a person: open each file the banner
lists, bring it to the content you want, and save — saving pushes your
reconciled version, and the next sync goes through.

## Limits

- Each Hexis replica holds its own clones; a call reaches one replica.
- Pull requests on the host are not mirrored into Hexis change requests. The
  sync keeps change-request state consistent with what the host now holds
  (a request whose branch was deleted on the host is closed), nothing more.
