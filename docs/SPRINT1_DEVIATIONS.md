# Sprint 1 Deviations

This document records implementation differences from the submitted BMS SRS/SAD.

| Area | Submitted design | Sprint 1 implementation | Reason | Final action |
|---|---|---|---|---|
| Data persistence | MySQL-oriented persistence | Local JSON persistence for the academic demo | Keeps the Sprint 1 demo self-contained and easy to run without a DB server | Integrate MySQL persistence during Sprint 2/final hardening |
| OTP delivery | OTP verification requirement | Local demo OTP flow | No external SMS/email provider is part of the academic repository | Replace demo delivery with a configured provider before production deployment |
| Transport security | TLS 1.2+ requirement | HTTPS is not terminated by the Node demo server in local development | Local demo is intended for localhost execution | Run behind HTTPS/TLS in the final deployment/test environment and document evidence |
| Staff/admin UI | SRS/SAD include administrative capabilities | Staff APIs and a basic staff loan-decision/report view are available; not every administrative use case has a UI | Sprint 1/early Sprint 2 prioritize core product flows | Continue staff/admin UI coverage as remaining requirements are delivered |
| Idempotency storage | Durable transaction/idempotency persistence | Withdrawal request keys and responses are saved with the local JSON demo store | Sprint 1 uses a self-contained demo store | For production, enforce an idempotency-key uniqueness constraint and save the key, debit, and ledger entry in one database transaction |
| Performance measurement | SRS response-time target | CI now measures median and p95 latency on three local in-memory API paths against a configurable threshold | Gives repeatable baseline evidence for the demo | Confirm the exact numeric limit in the submitted SRS and set `BMS_PERFORMANCE_TARGET_MS` to that value; CI's 2,000 ms default is provisional |

## Assessment

These deviations are intentional for the academic Sprint 1 implementation and do not remove the corresponding requirements from the backlog. The consolidated GitHub issues remain the source of truth for Sprint 1/Sprint 2 completion.
