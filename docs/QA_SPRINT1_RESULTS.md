# Sprint 1 QA Validation

**Tester:** SRIKANTH V REDDY  
**SRN:** PES2UG24CS519  
**Role:** QA Lead

## Scope

Sprint 1 QA covers authentication, OTP verification, customer profile/KYC, balance inquiry, deposit, withdrawal, fund transfer, beneficiary management, and the security controls related to password hashing, RBAC, login lockout and audit logging.

## Test execution status

The following browser/local-manual checks were executed on the development machine. Results marked PASS are supported by the captured application screenshots and observed responses.

| Test area | Expected evidence | Status |
|---|---|---|
| Login with valid credentials | Successful transition to OTP | PASS |
| Login with invalid credentials | Request rejected | PASS |
| OTP valid/invalid/expired behavior | Correct acceptance/rejection | PASS — valid OTP verified; invalid/expired OTP not separately tested |
| Customer profile/KYC | Customer profile and KYC status displayed | PASS |
| Balance inquiry | Correct account balance shown | PASS |
| Cash deposit | Balance and transaction updated | PASS |
| Cash withdrawal | Valid debit and transaction recorded | PASS |
| Fund transfer | Successful transfer and transaction recorded | PASS |
| Beneficiary management | Beneficiary successfully added | PASS |
| RBAC | Customer denied staff-only operations | PASS — HTTP 403 / Insufficient privileges observed |
| Login lockout | Five failures cause temporary lockout | PASS — temporary lockout observed after five incorrect passwords |
| Audit logging | Events recorded without sensitive credentials | PENDING LOCAL |

### Manual evidence captured

The following manual evidence was captured during local execution:

- Valid customer login and OTP verification
- Customer dashboard and account balances
- Cash deposit
- Cash withdrawal
- Beneficiary creation
- Successful fund transfer
- Transaction history
- Customer attempt to access staff-only reporting API resulting in HTTP 403
- Five incorrect password attempts resulting in temporary account lockout

## Automated evidence

The current regression suite covers authentication/OTP behavior, account ownership, deposits, withdrawals, transfers, loans, reports, audit privacy/integrity and accessibility-related static checks. The CI workflow also runs the performance baseline. These automated results do not replace browser/manual acceptance testing.

## Security review checklist

- [x] Passwords are salted and hashed with Node.js scrypt.
- [x] The application does not intentionally log passwords or OTP values.
- [x] Staff-only routes use role checks.
- [x] Login lockout logic is implemented.
- [x] Audit metadata is sanitized for credential-like fields.
- [x] Audit records include an integrity hash chain.
- [x] Manual verification completed for the tested local security controls.
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


## Current GitHub backlog status

The consolidated backlog is #20–#49. At the time of this QA update, the remaining open requirements are:

| Issue | Requirement | QA status |
|---|---|---|
| #20 | BMS-F-001 Authentication | Implementation merged; manual browser acceptance pending |
| #21 | BMS-F-002 OTP Verification | Implementation merged; manual browser acceptance pending |
| #23 | BMS-F-004 Account Creation | Implementation merged; manual/staff acceptance pending |
| #29 | BMS-F-010 Beneficiary Management | Implementation present; manual acceptance pending |
| #31 | BMS-F-012 Account Statements | Not yet implemented/verified |
| #34 | BMS-F-015 Repayment Schedule | Calculation is present in the loan flow; acceptance/UI verification pending |
| #37 | BMS-F-018 User and Role Administration | Not yet fully implemented/verified |
| #42 | BMS-NF-003 Data Encryption | Not yet fully satisfied; production-grade encryption evidence pending |
| #45 | BMS-SR-001 TLS 1.2+ | Local demo does not terminate HTTPS/TLS; deployment evidence pending |
| #46 | BMS-SR-002 Secure Password Hashing | Implementation merged; code/automated evidence present; final acceptance pending |

Issues already closed in the consolidated backlog correspond to merged implementation work for the other Sprint 1/Sprint 2 requirements.

## QA Lead next gate

Do not mark the remaining requirements Done solely from source-code inspection. After local execution, the QA Lead should update the relevant issues with observed evidence, create defects for failures, and only then move the Project items to Done.
