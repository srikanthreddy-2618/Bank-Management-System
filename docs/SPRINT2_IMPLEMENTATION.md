# Sprint 2 Feature Implementation — Srujan Workstream

This document describes the first implementation pass for the Srujan-owned backlog items #32, #35, #38, #40 and #49. Balance inquiry and withdrawal (#25 and #27) remain in the prior Sprint 1 implementation and need browser acceptance by the team.

## Loan application — BMS-F-013 / Issue #32

- Customers can submit loan applications with a positive amount, a purpose from 5–240 characters, and a tenure from 1–360 months.
- The application is saved with a generated ID and `PENDING` status.
- Customers see only their own applications; staff can review all applications.
- Staff can approve or reject pending applications.
- Approval requires an annual interest rate from 0–100% and a selected active account belonging to the applicant. The principal is credited to that account and recorded as a `LOAN_DISBURSEMENT` transaction.
- The API calculates a fixed monthly installment using the standard amortizing-payment formula and tracks the sum of the rounded installments as the total outstanding repayment amount.
- Invalid transitions are rejected.

API routes:
- `POST /api/loans`
- `GET /api/loans`
- `GET /api/loans/:id`
- `PATCH /api/loans/:id/decision` (staff only)

## Loan repayment — BMS-F-016 / Issue #35

- Only the customer who owns an approved loan can submit repayments.
- The repayment requires an active account owned by the borrower and a positive amount.
- Repayments above the outstanding principal/balance and repayments with insufficient account funds are rejected.
- Accepted repayments debit the account, reduce the loan outstanding balance, create a `LOAN_REPAYMENT` transaction, add a repayment record and notify the customer.
- Each repayment requires an idempotency key; retrying the same request replays the original result rather than posting a second debit. The browser keeps the pending key in session storage across retries.
- A zero outstanding balance changes the loan status to `PAID`.

API route:
- `POST /api/loans/:id/repayments`

## Operational reports — BMS-F-019 / Issue #38

The staff-only `GET /api/admin/reports/summary` endpoint returns aggregate current-store metrics for:
- total, active, frozen and closed accounts, with summed balances;
- successful deposits, withdrawals and outbound transfers, with amounts and transaction counts by type;
- loan counts by status and total outstanding loan balance;
- audit event count and report-generation timestamp.

The report scope is explicitly marked `CURRENT_LOCAL_DEMO_STORE`. It is not a historical warehouse report or a production reporting service.

## Performance — BMS-NF-001 / Issue #40

Run:

```bash
npm run performance
```

The script warms up and measures 100 requests per endpoint by default and prints sample count, median, p95 and max latency for:
- `GET /api/health`
- `GET /api/accounts` as a customer
- `GET /api/admin/reports/summary` as staff

The CI workflow runs this benchmark with a configurable p95 threshold of 2,000 ms. The latest validated run measured p95 at 1.43 ms for health, 0.65 ms for customer account listing and 0.76 ms for staff report generation ([CI evidence](https://github.com/srikanthreddy-2618/Bank-Management-System/actions/runs/39006409802)). The issue body does not state a numeric SRS threshold, and the PDF source did not resolve to searchable text during this implementation pass. Therefore, 2,000 ms is a provisional engineering threshold, not evidence that the exact SRS value has been confirmed. Set `BMS_PERFORMANCE_TARGET_MS` to the exact value from the submitted SRS once verified. Results measure a local in-memory demo and do not include a production database or network latency.

Optional variables:
- `BMS_PERFORMANCE_TARGET_MS`: allowed p95 latency in milliseconds.
- `BMS_PERFORMANCE_ITERATIONS`: samples per endpoint (20–500; default 100).

## Secure audit logging — BMS-SR-005 / Issue #49

- Success and failure events are recorded for authentication, OTP verification, withdrawals, loan submission/decisions/repayments and operational report generation.
- Authentication failures store a reason category rather than the submitted password, OTP, token or email address.
- Audit metadata passes through a sensitive-key filter before storage.
- The audit endpoint is available only to staff: `GET /api/admin/audit`.
- API regression tests assert that raw password and OTP test values do not appear in retrieved audit records.

The JSON demo store is still a single-process academic store. A production deployment must persist audit records to protected append-only/retention-controlled storage and use transactional database constraints for financial records and idempotency.

## Verification

The API test suite includes loan application/approval, repayment balance and transaction recording, invalid repayment rejection, report access control, and audit privacy checks. The CI workflow also runs syntax checks, the regression suite, and the performance baseline.

## Transaction history — BMS-F-011 / Issue #30

- `GET /api/transactions` returns the history for one selected account (`accountId`) or, without it, every account the caller may see (customers: their own; staff: all). An account the caller does not own returns `403`.
- Optional `from` and `to` query parameters filter by creation time, inclusive at both ends. They accept ISO dates (`YYYY-MM-DD`; a date-only `to` runs to the end of that day, UTC) or ISO timestamps. Invalid values, repeated parameters, or a `from` after `to` return `400`.
- Only entries that belong to the selected account(s) are returned. Previously the counterparty account was matched too, so a transfer also returned the other party's ledger row, including that account's balance after the transfer.
- The dashboard has an account selector, From/To date inputs, Apply and Clear. The browser sends the user's local day boundaries as ISO timestamps so the range matches the dates they picked. The selection survives dashboard refreshes.

## Loan approval, rejection and return — BMS-F-014 / Issue #33

- `PATCH /api/loans/:id/decision` (staff only) accepts `APPROVED`, `REJECTED` or `RETURNED` for a `PENDING` application.
- Every decision records the deciding staff user (`decidedBy`), the time (`decisionAt`) and the `reason`, and writes a `LOAN_APPLICATION_DECIDED` audit entry containing the same details.
- A reason of 5-240 characters is required to reject or return an application and is optional on approval. The applicant sees the status and reason in their loan list and notification.
- Only pending applications can be decided, so a repeated approval cannot disburse twice (`409`). Approval still requires a rate and an active account belonging to the applicant.
- A returned application is closed with its reason; the applicant submits a new application with the corrections (there is no edit-and-resubmit flow yet). The operational report counts returned applications separately.

## Audit trail — BMS-F-020 / Issue #39

- Every audit record carries `id`, `userId`, `timestamp`, `action`, `result` (`SUCCESS` or `FAILURE`) and sanitized `metadata` (passwords, OTPs, tokens and secrets are never stored). Actions that record a refused, failed, blocked, denied or conflicting attempt (`*_REJECTED`, `*_FAILED`, `*_BLOCKED`, `*_DENIED`, `*_CONFLICT`) are `FAILURE`; everything else is `SUCCESS`. Records written before this change get the same result when read.
- New events: `ACCESS_DENIED` (a role check refused a request: method, path and role are recorded) and `AUDIT_LOG_VIEWED` (who read the trail and with which filters).
- `GET /api/admin/audit` (staff only) returns `{ auditLogs, total, limit, offset }`, newest first, with optional filters `userId`, `action` (exact, UPPER_CASE), `result`, `from`/`to` (inclusive, ISO date or timestamp), `limit` (1-1000, default 500) and `offset`. Invalid filters return `400`.
- The staff dashboard has an Audit Trail panel (result, action and date filters). It loads only when the filter form is submitted, so routine dashboard refreshes do not flood the trail with `AUDIT_LOG_VIEWED` entries.
- Retention and tamper-evidence are covered separately by issue #43 (BMS-NF-004).

## Audit log retention and verification — BMS-NF-004 / Issue #43

- Retention period: `BMS_AUDIT_RETENTION_DAYS` (whole days, minimum 1; invalid values fall back to the default). The default of 2555 days (7 years) is provisional until the organization confirms its policy.
- Audit records are hash-chained: each record stores `prevHash` and a SHA-256 `hash` over its own content and the previous hash. Editing a record, changing its time, deleting one or reordering them breaks the chain. Records written before this change are counted as legacy (not verified); the first hashed record after them starts the verified chain.
- `GET /api/admin/audit/retention` (staff only) reports the retention period, the cutoff, how many records are retained, the oldest and newest record times, how many are past retention, and the chain verification result (`verified`, `checked`, `brokenRecordId`, `reason` of `RECORD_MODIFIED` or `CHAIN_LINK_MISMATCH`). Each check is audited (`AUDIT_INTEGRITY_CHECKED`, or `AUDIT_INTEGRITY_CHECK_FAILED` with result FAILURE).
- `POST /api/admin/audit/retention/purge` (staff only, body `{ "confirm": true }`) removes only the oldest records that are past the retention period. Nothing is ever deleted automatically or inside the period. The newest removed record becomes the chain anchor so the retained chain still verifies, and the purge is audited (`AUDIT_RETENTION_PURGED`, with the number removed).
- Retrieved records include `prevHash` and `hash` so an auditor can check them independently. The Audit Trail panel has a "Check retention & integrity" button.
- The store is still the single-process JSON demo store; a deployed system would add write-once or off-host storage so the chain cannot be rewritten wholesale.

## Usability and accessibility — BMS-NF-005 / Issue #44

- Navigation: a "Skip to main content" link, a focusable main landmark, and focus moved to the OTP field after the password step and to the welcome heading after login. A visible `:focus-visible` ring is defined for every control.
- Labels and input purpose: every control has a programmatic label; login, OTP and profile fields declare `autocomplete`; phone uses `type="tel"`; the loan purpose has a described length hint; each Remove button names its beneficiary; the decorative emoji is hidden from screen readers.
- Feedback and validation: login errors are announced (`role="alert"`). Operation errors use a separate alert toast ("Error: ...") that stays for 8 seconds; success messages use a polite status toast. Previously every message vanished after under 3 seconds and none were announced.
- Tables: captions, `scope="col"` headers, and scrollable regions that are named and reachable by keyboard.
- Contrast: form borders raised from 1.48:1 to 3.65:1 (WCAG 1.4.11); text pairs verified at 4.5:1 or better.
- `docs/UX_ACCESSIBILITY_CHECKLIST.md` holds the proposed TC-UX-01 checklist, the automated evidence, and the manual steps for the Test Engineer.
