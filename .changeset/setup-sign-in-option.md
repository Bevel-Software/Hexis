---
'@bevel-software/platform-core-frontend': minor
---

The first-run setup screen asks for two things only: the repository and single sign-on. The Audit log and Marketplace sections stay on the Deployment page, where they have always been available.

A distribution can offer a way to sign in that it runs itself, through the new `signInOption` registry slot. The Single sign-on section then shows two tabs: the distribution's, opened by default, and the form for the deployment's own identity provider, opened by default once one is configured. Without the slot the section is unchanged.

The login screen explains two more refusals a sign-in provider can report: an account that has not been invited, and an email address the provider has not verified.
