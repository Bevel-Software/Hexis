---
'@bevel-software/platform-core-frontend': minor
---

The Deployment page has a slot for the distribution that runs it: `deploymentPanel` on the app registry, a component rendered at the foot of the page, below the settings form. Core's page holds what every deployment has (the repository, the branch model, sign-in); what a deployment is beyond that, such as a hosted workspace's plan or its deletion by its admin, belongs to the distribution. The panel is shown to admins only, like the page, and does not depend on the settings having loaded. With no panel registered the page is unchanged.
