# Final QA Validation Status

**QA Lead:** SRIKANTH V REDDY  
**SRN:** PES2UG24CS519

## Automated validation added

- Core regression suite remains in CI.
- Added regression coverage for account statements, user/role administration, customer account creation and complete loan repayment schedules.
- Added negative OTP validation for invalid and expired OTPs.
- Added audit verification ensuring the OTP failure events are recorded without exposing the OTP value.
- CI also runs syntax checks, repository structure checks, secret scanning and the performance baseline.

## Manual QA already completed

The previous local Sprint 1 QA execution recorded PASS for valid login/OTP, invalid credentials, profile/KYC, balances, deposit, withdrawal, transfer, beneficiary management, RBAC denial and five-attempt lockout.

## Remaining manual/evidence gates

| Area | Status |
|---|---|
| Invalid OTP browser flow | Automated regression added; browser screenshot still needed for full manual evidence |
| Expired OTP browser flow | Automated regression added; browser screenshot still needed for full manual evidence |
| Audit log browser verification | Automated regression added; manual browser evidence still needed |
| HTTPS/TLS browser/deployment evidence | Pending real certificate/key deployment |
| QA screenshots in GitHub | Not uploaded; only the evidence README is present |
| GitHub Actions evidence screenshot | Capture required for submission |
| GitHub Project board evidence screenshot | Capture required for submission |
| Final teammate QA review | Pending |

## Sign-off rule

QA should only be marked fully complete after the remaining browser/evidence items above are captured and reviewed. The automated regression suite must be green before the feature PR is merged.

