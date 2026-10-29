# Test Execution Report

**Project:** Bank Management System   

## Features Tested

| Requirement ID | Feature | Test Case | Result |
|----------------|---------|-----------|--------|
| BMS-F-001 / F-002 | Authentication and OTP | TC-AUTH-01, TC-AUTH-02 | Pass |
| BMS-F-003 | Customer Profile and KYC | TC-CUST-01 | Pass |
| BMS-F-004 / F-005 | Account Creation / Status | TC-ACC-01, TC-ACC-02 | Pass |
| BMS-F-006 | Balance Inquiry | TC-BAL-01 | Pass |
| BMS-F-007 | Cash Deposit | TC-DEP-01 | Pass |
| BMS-F-008 | Cash Withdrawal | TC-WD-01 | Pass |
| BMS-F-009 / F-010 | Fund Transfer / Beneficiaries | TC-TRF-01, TC-BEN-01 | Pass |
| BMS-F-011 / F-012 | Transaction History / Statements | TC-HIST-01, TC-STMT-01 | Pass |
| BMS-F-013 to F-016 | Loan Management | TC-LOAN-01 to TC-LOAN-04 | Pass |
| BMS-F-017 | Notifications | TC-NOTIF-01 | Pass |
| BMS-F-018 | Administration / RBAC | TC-ADMIN-01 | Pass |
| BMS-F-019 | Operational Reports | TC-REP-01 | Pass |
| BMS-F-020 | Audit Trail | TC-AUD-01 | Pass |
| BMS-NF-001 | Response Time (≤ 3 seconds) | TC-PERF-01 | Pass |

## Additional Validation

The following validation scenarios were also checked:

- Login with valid credentials
- Login with invalid credentials
- OTP verification
- Invalid OTP
- Expired OTP
- Deposit with invalid amount
- Withdrawal with insufficient balance
- Transfer validation
- Dashboard and balance display
- Transaction history
- Logout

All the above tests behaved as expected.

## Test Evidence

Screenshots are available in the `screenshots` folder.

Examples:

- 01_Login_page.png
- 02_otp_verification.png
- 03_dashboard.png
- 04_Invalid_Amount.png
- 05_withdraw.png
- 06_Insufficient_Balance.png
- 07_logout.png
- 08_transfer.png
- 09_beneficiary.png
- 10_history.png
- 11_loan_application.png
- 12_loan_history.png
- 13_invalid_transfer.png
- 15.TLS_1.3_Validation.png
- 16.TLS_HTTPS_Browser_Evidence.png
- 17_Invalid_OTP.png
- 18_Expired_OTP.png

## Bugs

No major issues were found during testing. All assigned test cases completed successfully.

## Final Result

Overall, the tested features are working as expected and all assigned functional test cases passed.