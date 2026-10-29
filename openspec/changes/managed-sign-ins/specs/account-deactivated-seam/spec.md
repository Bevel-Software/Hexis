## ADDED Requirements

### Requirement: Switching an account off runs the deactivated listeners
After an admin switches an account off, core SHALL run every `onAccountDeactivated` listener with the account's id and email, awaited, in registration order; a listener that throws SHALL be logged and SHALL not fail the switch-off; the admin's answer SHALL not depend on what the listeners did.

#### Scenario: A listener lets go of what the account held
- **WHEN** an account is switched off and a listener removes the person's managed sign-ins
- **THEN** the route answers 204 after the listener ran

#### Scenario: No listener
- **WHEN** a core-only deployment switches an account off
- **THEN** the route answers as before
