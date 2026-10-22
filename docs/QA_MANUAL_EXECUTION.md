# Sprint 1 Manual QA Execution

## Environment

- Application: Bank Management System
- Runtime: Node.js
- URL: `http://localhost:3000`
- Demo customer: `customer@bms.local`
- Demo staff: `staff@bms.local`
- Demo OTP: `123456`

## Execute

1. Start the application with `npm install` and `npm start`.
2. Complete customer login and OTP.
3. Verify profile/KYC information.
4. Record the displayed customer account balances.
5. Perform a valid deposit and verify the balance/history.
6. Test zero/negative deposit rejection if exposed by the UI.
7. Perform a valid withdrawal and verify the balance/history.
8. Test zero/negative/insufficient withdrawal and ensure no debit occurs.
9. Add a beneficiary and remove it.
10. Perform a valid transfer to `1000002001`.
11. Test an invalid destination, same-account destination, and insufficient-balance transfer.
12. Refresh the dashboard and confirm transaction history remains correct.
13. Attempt a staff-only action as a customer and confirm access is denied.
14. Submit five incorrect passwords and confirm temporary lockout.
15. Verify server/application logs contain no raw password or OTP values.
16. Log in as staff and verify the audit trail records outcomes without sensitive credentials.
17. Run `npm test`, `npm run check`, and `npm run performance`.
18. Capture the screenshots listed in `screenshots/README.md`.

## Reporting

For each test record PASS or FAIL only after observing it locally. For a failure, create a GitHub issue with steps, expected result, actual result, severity/priority, and evidence. QA re-tests the fix after the developer's PR is merged.
