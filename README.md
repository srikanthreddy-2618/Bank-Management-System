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
- Cash deposit
- Cash withdrawal with insufficient-balance validation
- Fund transfer
- Beneficiary add/remove
- Transaction history
- Notifications
- Role-aware staff operations
- Salted password hashing using Node.js scrypt
- Five-attempt temporary login lockout
- Audit logging without passwords/OTP values

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

The architecture is aligned with the submitted SRS/SAD, with the local JSON store used to keep the academic demo easy to run. `database/schema.sql` preserves the MySQL-oriented design for the planned persistent deployment.

## Run locally

Prerequisites: Node.js 20+.

```bash
npm install
npm start
```

Open **http://localhost:3000**

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
├── docs/
│   ├── PROJECT_PLAN.md
│   └── SPRINT1_IMPLEMENTATION.md
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

See `docs/SPRINT1_IMPLEMENTATION.md` for the Sprint 1 scope and known deviations.
