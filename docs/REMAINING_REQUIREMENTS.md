# Remaining Requirements Implementation

## Implemented in this feature branch

### BMS-F-012 — Account Statements
- Added GET /api/accounts/:id/statement.
- Enforces account ownership for customers and staff access for all accounts.
- Supports optional inclusive from / to date filters.
- Returns opening balance, total credits, total debits, closing balance and transaction rows.
- Added browser UI with account/date selection and generated statement table.
- Added regression tests for statement totals and cross-account denial.

### BMS-F-015 — Repayment Schedule
- Approved loans now retain a complete installment schedule.
- The schedule records installment number, due month, installment amount and outstanding balance after each installment.
- The customer loan table exposes the schedule through a collapsible details control.
- Added regression coverage for a 12-installment schedule.

### BMS-F-018 — User and Role Administration
- Added staff-only GET /api/admin/users.
- Added staff-only POST /api/admin/users.
- Added staff-only PATCH /api/admin/users/:id/role.
- Staff UI supports user creation and role changes between CUSTOMER and STAFF.
- Added staff account-creation UI using the existing staff-only account creation API.
- Added regression coverage for listing, creation, role changes, account creation and customer denial.

### BMS-NF-003 — Data Encryption
- Added optional AES-256-GCM encryption for the local JSON persistence store using BMS_STORE_ENCRYPTION_KEY.
- Existing plaintext demo stores remain backward-compatible when the key is not configured.
- The repository does not contain an encryption secret.

### BMS-SR-001 — TLS 1.2+
- Added optional HTTPS server startup using BMS_TLS_KEY_FILE, BMS_TLS_CERT_FILE and optional BMS_TLS_CA_FILE.
- When certificate and key paths are supplied, the Node server uses HTTPS instead of HTTP.
- CI now generates an ephemeral self-signed certificate and verifies an HTTPS health request negotiates TLS 1.2 or TLS 1.3. A real certificate/key deployment is still required for production/browser acceptance.

## Remaining deployment-specific work

- Provide and validate a real TLS certificate/key deployment.
- Configure a strong encryption key outside source control.
- Replace the local JSON store with transactional MySQL persistence for production.
- Confirm stakeholder-configured transfer limits, audit retention period and exact performance threshold.
- Complete manual acceptance and issue closure in GitHub after review.

