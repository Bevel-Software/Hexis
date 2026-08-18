---
'@bevel-software/platform-core-backend': patch
---

Two latent defects out of the seeding machinery.

The packaged template can seed `.gitignore` again: npm strips every file by
that name from a published tarball, so the template now ships it as
`gitignore.template` and the seeder writes it under its real name — a
template carrying the literal file (a distribution's own `KB_TEMPLATE_DIR`)
still wins outright. Previously, any consumer of the packaged template had a
top-up that ENOENTed on the missing file and silently abandoned the whole
run, migrations included.

The break-glass `roles.yaml` recovery now restores THIS deployment's
configured admins (`ADMIN_EMAIL`) instead of a roster hard-coded into the
build, and refuses when none is configured — an adminless roles.yaml is the
unusable state recovery exists to escape, not a cure for it.
