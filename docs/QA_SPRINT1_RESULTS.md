# Sprint 1 QA Validation

**Tester:** SRIKANTH V REDDY  
**SRN:** PES2UG24CS519  
**Role:** QA Lead

## Scope

Sprint 1 QA covers authentication, OTP verification, customer profile/KYC, balance inquiry, deposit, withdrawal, fund transfer, beneficiary management, and the security controls related to password hashing, RBAC, login lockout and audit logging.

## Test execution status

The repository CI pipeline provides automated API coverage for core banking and security behavior. The latest `main` branch CI runs are passing.

The following browser/local-manual checks must be executed on the team's development machine before marking them PASS:

| Test area | Expected evidence | Status |
|---|---|---|
| Login with valid credentials | Successful transition to OTP | PENDING LOCAL |
| Login with invalid credentials | Request rejected | PENDING LOCAL |
| OTP valid/invalid/expired behavior | Correct acceptance/rejection | PENDING LOCAL |
| Customer profile/KYC | View/update and validation | PENDING LOCAL |
| Balance inquiry | Correct account balance shown | PENDING LOCAL |
| Cash deposit | Balance and transaction updated | PENDING LOCAL |
| Cash withdrawal | Valid debit and invalid rejection | PENDING LOCAL |
| Fund transfer | Source/destination balance consistency | PENDING LOCAL |
| Beneficiary management | Add/remove/validation | PENDING LOCAL |
| RBAC | Customer denied staff-only operations | PENDING LOCAL |
| Login lockout | Five failures cause temporary lockout | PENDING LOCAL |
| Audit logging | Events recorded without sensitive credentials | PENDING LOCAL |

## Security review checklist

- [x] Passwords are salted and hashed with Node.js scrypt.
- [x] The application does not intentionally log passwords or OTP values.
- [x] Staff-only routes use role checks.
- [x] Login lockout logic is implemented.
- [x] Audit metadata is sanitized for credential-like fields.
- [x] Audit records include an integrity hash chain.
- [ ] Manual verification on the local runtime.
- [ ] HTTPS/TLS evidence in the deployed/test environment.

## CI evidence

GitHub Actions runs the Node.js syntax checks, automated API tests, repository validation and secret scan. The latest runs on `main` are passing.

## Defect handling

Any failed manual test should be recorded as a GitHub issue with:
- reproducible steps,
- expected result,
- actual result,
- severity/priority,
- screenshot or other evidence.

The developer should then fix the defect through a feature branch and pull request. QA re-tests the fix before the issue is marked Done.

## QA completion criteria

Sprint 1 QA can be marked complete only after:
1. All required manual tests have recorded PASS/FAIL results.
2. Critical defects are resolved or explicitly accepted by the Product Owner.
3. GitHub Actions is green.
4. Test evidence is attached to the relevant issues/PRs.
5. The final QA result is reviewed by the team.
