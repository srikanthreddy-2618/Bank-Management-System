# Sprint 1 Deviations

This document records implementation differences from the submitted BMS SRS/SAD.

| Area | Submitted design | Sprint 1 implementation | Reason | Final action |
|---|---|---|---|---|
| Data persistence | MySQL-oriented persistence | Local JSON persistence for the academic demo | Keeps the Sprint 1 demo self-contained and easy to run without a DB server | Integrate MySQL persistence during Sprint 2/final hardening |
| OTP delivery | OTP verification requirement | Local demo OTP flow | No external SMS/email provider is part of the academic repository | Replace demo delivery with a configured provider before production deployment |
| Transport security | TLS 1.2+ requirement | HTTPS is not terminated by the Node demo server in local development | Local demo is intended for localhost execution | Run behind HTTPS/TLS in the final deployment/test environment and document evidence |
| Staff/admin UI | SRS/SAD include administrative capabilities | Staff operations are exposed through protected API routes; the current UI focuses on the customer Sprint 1 flow | Sprint 1 demo prioritizes the core customer journey | Add administrative UI in Sprint 2 |

## Assessment

These deviations are intentional for the academic Sprint 1 implementation and do not remove the corresponding requirements from the backlog. The consolidated GitHub issues remain the source of truth for Sprint 1/Sprint 2 completion.
