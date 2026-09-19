---
'@bevel-software/platform-core-frontend': patch
---

Every surface that saves a tool key now probes it afterwards and says when the provider refused it. A tester saved a deliberately invalid key from the vault and from the Connect your tools page; both stored it, both said `Key saved`, and nothing anywhere mentioned that the provider had already rejected it. The tool page had run the manual's non-mutating health check after a save for a while — the other two stored the value and stopped, which made them the quietest places in the app to install a key that would fail hours later, in an agent, with the key no longer to hand.

The probe's lifecycle is now one hook (`useSavedKeyProbe`) and its words one function (`probeWords`), both read by all three surfaces, so a single rejection cannot come out as two different complaints depending on where the key was typed. A rejected key shows the provider's own status text in a danger banner beside the row; a passing one shows the quiet connected state with the time of the check behind it. A manual that defines no health check now says `Unverified` with the reason on the page rather than only in a tooltip — including on the tool page, which used to answer `Key saved` there and report the storage rather than the attempt. A probe that could not run at all says the check did not run, never that the key is wrong.

Saving is never blocked by any of this: the value is stored and the field cleared before the probe starts, the call is not awaited, and a probe that hangs, fails or does not exist costs the person nothing. The submitted secret is not an input to the result — `probeWords` takes the verdict alone, so no rendering built on it has a value to leak.

The Secrets page and the Connect page refetch quietly after a save. The loud refresh dropped both to `Loading…`, which unmounted the very row holding the answer its own save had just asked for; this is the fix `useToolPage` already made for the tool page, for the same reason.
