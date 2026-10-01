## ADDED Requirements

### Requirement: An account is admitted before it is created
Before an account is created, by single sign-on or by an admin, the auth service SHALL ask the `accountAdmission` port whether the email may be provisioned and why (`sso`, `admin-create`, `bootstrap`). Core SHALL admit everyone by default. A refusal SHALL create nothing and SHALL surface the port's message to the caller.

#### Scenario: Seat available
- **WHEN** the port admits the email
- **THEN** the account is created as before

#### Scenario: Seats exhausted on SSO
- **WHEN** a new user signs in through SSO and the port refuses
- **THEN** no account is created and the sign-in fails with the port's message

#### Scenario: Seats exhausted on admin create
- **WHEN** an admin creates an account and the port refuses
- **THEN** the request fails with the port's message and nothing is stored

#### Scenario: No port configured
- **WHEN** a deployment fills no `accountAdmission` port
- **THEN** every account is admitted
