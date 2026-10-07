# Sprint 1 Implementation

## Scope

This implementation turns the BMS documentation backlog into a runnable web application for the Sprint 1 flow.

## Implemented areas

| SRS ID | Implementation |
|---|---|
| BMS-F-001 | Customer/staff password authentication |
| BMS-F-002 | OTP verification with demo-only local OTP |
| BMS-F-003 | Customer profile/KYC display and update |
| BMS-F-004 | Staff account creation API |
| BMS-F-005 | Staff account lifecycle API |
| BMS-F-006 | Balance inquiry dashboard |
| BMS-F-007 | Cash deposit |
| BMS-F-008 | Cash withdrawal with insufficient-balance validation |
| BMS-F-009 | Fund transfer with source/destination validation |
| BMS-F-010 | Beneficiary add/remove |
| BMS-SR-002 | Passwords stored as salted scrypt hashes, never plaintext |
| BMS-SR-003 | Role-aware middleware for staff-only operations |
| BMS-SR-004 | Five-attempt temporary login lockout |
| BMS-SR-005 | Audit logging that excludes passwords and OTP values |

## Development/demo notes

The local academic demo uses a JSON persistence store so the application can be run without a database server. The repository also contains `database/schema.sql` as the MySQL-oriented persistence design from the SAD.

OTP delivery to SMS/email is not integrated yet. In demo mode the API returns the fixed demo OTP to the browser only; the OTP is never printed to application logs. Production deployment must replace this with an approved delivery provider and a secret outside source control.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Demo customer:
- Email: `customer@bms.local`
- Password: `Password@123`
- Demo OTP: `123456`

Demo transfer destination:
- Account: `1000002001`

## Test

```bash
npm test
```

The CI workflow runs syntax checks, automated API tests, repository checks and the basic secret scan.
