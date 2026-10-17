# Sprint 2 Feature Implementation — Srujan Workstream

This document describes the first implementation pass for the Srujan-owned backlog items #32, #35, #38, #40 and #49. Balance inquiry and withdrawal (#25 and #27) remain in the prior Sprint 1 implementation and need browser acceptance by the team.

## Loan application — BMS-F-013 / Issue #32

- Customers can submit loan applications with a positive amount, a purpose from 5–240 characters, and a tenure from 1–360 months.
- The application is saved with a generated ID and `PENDING` status.
- Customers see only their own applications; staff can review all applications.
- Staff can approve or reject pending applications.
- Approval requires an annual interest rate from 0–100% and calculates a fixed monthly installment using the standard amortizing-payment formula.
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

The CI workflow runs this benchmark with a configurable p95 threshold of 2,000 ms. The issue body does not state a numeric SRS threshold, and the PDF source did not resolve to searchable text during this implementation pass. Therefore, 2,000 ms is a provisional engineering threshold, not evidence that the exact SRS value has been confirmed. Set `BMS_PERFORMANCE_TARGET_MS` to the exact value from the submitted SRS once verified. Results measure a local in-memory demo and do not include a production database or network latency.

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
