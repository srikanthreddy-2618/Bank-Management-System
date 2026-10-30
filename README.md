# 🏦 Bank Management System

Software Engineering project — a secure, role-aware web application for core banking operations.

## Team

| Member | SRN | Role | GitHub |
|---|---|---|---|
| SRIKANTH V REDDY | PES2UG24CS519 | QA Lead | @srikanthreddy-2618 |
| T. MAHALAKSHMI | PES2UG24CS558 | Test Engineer | @mahalakshmi-prog |
| SUDHANWA | PES2UG24CS531 | Developer | @extrmly85 |
| SRUJAN | PES2UG24CS526 | Product Owner / Bank Representative | @srujangithubit |

## Current implementation

Sprint 1 now has a runnable web application covering the primary customer banking flow:

- Customer/staff password authentication
- OTP verification
- Customer profile and KYC status
- Account viewing, staff account creation and lifecycle management
- Balance inquiry
- Cash deposit with required idempotency keys, duplicate-retry protection and audited rejections
- Cash withdrawal with insufficient-balance validation, required idempotency keys and duplicate-retry protection
- Fund transfer with required idempotency keys, per-transfer limit, atomic debit/credit and audited rejections
- Beneficiary add/remove
- Transaction history for a selected account within an optional date range
- Notifications
- Role-aware staff operations
- Salted password hashing using Node.js scrypt
- Five-attempt temporary login lockout
- Loan application, staff approval/rejection and repayment schedule calculation
- Loan repayments debited from the borrower's account and recorded in transaction history
- Staff-only operational summary reports
- Secure audit events for authentication and financial operations, with sensitive metadata filtered
- Performance baseline benchmark for health, accounts and reports
- Audit logging without passwords/OTP values
- Accessible UI: skip link, labelled controls, announced errors, keyboard-reachable tables and WCAG AA contrast (checklist in `docs/UX_ACCESSIBILITY_CHECKLIST.md`)
- Hash-chained audit records with a configurable retention period, integrity verification and explicit, audited purge of expired records

The application is intentionally scoped for the academic sprint demo. SMS/email OTP delivery and production MySQL integration are identified as follow-up work.

## Architecture

```text
Browser UI
   │
   ▼
Node.js API
   ├── Authentication + OTP
   ├── Account Service
   ├── Transaction Service
   ├── Beneficiary Service
   ├── Notification Service
   └── Audit / RBAC
   │
   ├── Local JSON persistence (demo)
   └── MySQL schema design (database/schema.sql)
```

The architecture is aligned with the submitted SRS/SAD, with the local JSON store used to keep the academic demo easy to run. When persistence is enabled, the JSON store is encrypted at rest with AES-256-GCM and requires `BMS_STORE_ENCRYPTION_KEY`. `database/schema.sql` preserves the MySQL-oriented design for the planned persistent deployment.

## Run locally

Prerequisites: Node.js 20+.

```bash
npm install
# PowerShell example: set a strong 32+ character key outside source control
$env:BMS_STORE_ENCRYPTION_KEY="replace-with-a-strong-32-plus-character-secret"
npm start
```

When `BMS_PERSISTENCE=true` (the default), `BMS_STORE_ENCRYPTION_KEY` is required. The server refuses to start without it. Without TLS certificate paths, the server uses **http://localhost:3000**. To use HTTPS locally, follow the setup below.



### Local HTTPS setup (Windows)

The backend can serve HTTPS when both `BMS_TLS_KEY_FILE` and `BMS_TLS_CERT_FILE` are configured. For local development, use [mkcert](https://github.com/FiloSottile/mkcert) to create a locally trusted certificate.

1. Install mkcert and run the following in Command Prompt:

```cmd
mkcert -install
if not exist certs mkdir certs
mkcert -key-file certs\localhost-key.pem -cert-file certs\localhost-cert.pem localhost 127.0.0.1 ::1
```

2. In the same Command Prompt session used to start the server, configure the certificate paths:

```cmd
set BMS_TLS_KEY_FILE=certs\localhost-key.pem
set BMS_TLS_CERT_FILE=certs\localhost-cert.pem
set BMS_TLS_CA_FILE=
```

3. Set `BMS_STORE_ENCRYPTION_KEY` to the original key for the existing encrypted local database. Keep that secret outside source control; changing it without migrating the data makes the encrypted store unreadable.

4. Start the application with `npm start` and open **https://localhost:3000**. If TLS variables are not set, the application continues to use HTTP.

To validate TLS support independently, run:

```cmd
npm run tls:test
```

The automated test creates a temporary self-signed certificate and verifies an HTTPS health request negotiated TLS 1.2 or TLS 1.3. It requires OpenSSL to be available on the system PATH.

**Security:** Never commit `.env`, private keys, certificates, encryption keys, or local database files. Local certificates are generated separately on each developer's machine.

### Demo customer

- Email: `customer@bms.local`
- Password: `Password@123`
- OTP in demo mode: `123456`

A second demo account is available for transfer testing:

- Account number: `1000002001`

### Test

```bash
npm run check
npm test
npm run performance
npm run tls:test
```

## Repository structure

```text
Bank-Management-System/
├── backend/
│   └── server.js
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── database/
│   └── schema.sql
├── tests/
│   └── api.test.js
├── scripts/
│   └── performance-test.js
├── docs/
│   ├── PROJECT_PLAN.md
│   ├── SPRINT1_IMPLEMENTATION.md
│   └── SPRINT2_IMPLEMENTATION.md
├── .github/
│   ├── pull_request_template.md
│   └── workflows/bms-ci.yml
├── BMS_SRS.pdf
├── BMS_SAD.pdf
├── BMS_Test_Plan.pdf
└── README.md
```

## Agile / GitHub workflow

The consolidated SRS backlog is tracked in GitHub Issues #20–#49 and planned across two sprints. The repository also contains a PR template and GitHub Actions CI.

Development flow:

```text
Issue → Feature branch → Commit → Pull Request → CI → Review → Merge → Done
```

## Security demo notes

The local demo uses a fixed OTP only when `BMS_DEMO_MODE=true`. The application does not write OTPs or passwords to logs. For deployment, set a strong `BMS_JWT_SECRET`, disable demo OTP mode and integrate an approved OTP delivery provider.

See `docs/SPRINT1_IMPLEMENTATION.md` for Sprint 1 scope, `docs/SPRINT2_IMPLEMENTATION.md` for the loan/report/audit/performance work, and `docs/SPRINT1_DEVIATIONS.md` for known deviations.
