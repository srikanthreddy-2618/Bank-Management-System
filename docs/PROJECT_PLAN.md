# BMS GitHub Project Plan

## Team

| Member | GitHub | SRN | Role |
|---|---|---|---|
| SRIKANTH V REDDY | @srikanthreddy-2618 | PES2UG24CS519 | QA Lead |
| T. MAHALAKSHMI | @mahalakshmi-prog | PES2UG24CS558 | Test Engineer |
| SUDHANWA | @extrmly85 | PES2UG24CS531 | Developer |
| SRUJAN | @srujangithubit | PES2UG24CS526 | Product Owner / Bank Representative |

## Sprint Schedule

- Dry-run / practice: 12 Oct – 16 Oct 2026
- Sprint 1: 19 Oct – 23 Oct 2026
- Sprint 2: 26 Oct – 30 Oct 2026

## Sprint 1 Backlog

| Requirement | Story Points | Planned Owner |
|---|---:|---|
| BMS-F-001 Authentication | 5 | SRIKANTH V REDDY |
| BMS-F-002 OTP Verification | 3 | SRIKANTH V REDDY |
| BMS-F-003 Customer Profile/KYC | 3 | T. MAHALAKSHMI |
| BMS-F-004 Account Creation | 5 | SUDHANWA |
| BMS-F-005 Account Lifecycle | 3 | SUDHANWA |
| BMS-F-006 Balance Inquiry | 2 | SRUJAN |
| BMS-F-007 Cash Deposit | 5 | SUDHANWA |
| BMS-F-008 Cash Withdrawal | 5 | SRUJAN |
| BMS-F-009 Fund Transfer | 8 | SUDHANWA |
| BMS-F-010 Beneficiary Management | 3 | SRIKANTH V REDDY |
| BMS-SR-001 TLS 1.2+ | 3 | SRIKANTH V REDDY |
| BMS-SR-002 Password Hashing | 5 | SRIKANTH V REDDY |
| BMS-SR-003 RBAC | 5 | T. MAHALAKSHMI |
| BMS-SR-004 Login Lockout | 3 | T. MAHALAKSHMI |

**Sprint 1 total: 58 points**

## Sprint 2 Backlog

| Requirement | Story Points | Planned Owner |
|---|---:|---|
| BMS-F-011 Transaction History | 3 | SUDHANWA |
| BMS-F-012 Account Statements | 3 | SRIKANTH V REDDY |
| BMS-F-013 Loan Application | 5 | SRUJAN |
| BMS-F-014 Loan Approval/Rejection | 5 | SUDHANWA |
| BMS-F-015 Repayment Schedule | 5 | SRIKANTH V REDDY |
| BMS-F-016 Loan Repayment | 5 | SRUJAN |
| BMS-F-017 Notifications | 3 | T. MAHALAKSHMI |
| BMS-F-018 User/Role Administration | 5 | T. MAHALAKSHMI |
| BMS-F-019 Operational Reports | 5 | SRUJAN |
| BMS-F-020 Audit Trail | 5 | SUDHANWA |
| BMS-NF-001 Performance | 5 | SRUJAN |
| BMS-NF-002 Availability | 5 | T. MAHALAKSHMI |
| BMS-NF-003 Data Encryption | 5 | T. MAHALAKSHMI |
| BMS-NF-004 Audit Retention | 3 | SUDHANWA |
| BMS-NF-005 Usability/Accessibility | 3 | SUDHANWA |
| BMS-SR-005 Secure Audit Logging | 5 | SRUJAN |

**Sprint 2 total: 70 points**

## Balanced Total Allocation

The assignments across both sprints are balanced at 32 story points per member:

| Member | Issues | Total Story Points |
|---|---|---:|
| SRIKANTH V REDDY | #20, #21, #23, #29, #31, #34, #45, #46 | 32 |
| SUDHANWA | #26, #28, #30, #33, #39, #43, #44 | 32 |
| SRUJAN | #25, #27, #32, #35, #38, #40, #49 | 32 |
| T. MAHALAKSHMI | #22, #24, #36, #37, #41, #42, #47, #48 | 32 |

## GitHub Project fields to configure

- **Requirement ID** — Text
- **Story Points** — Number
- **Priority** — Single select: High, Medium, Low
- **Sprint** — Iteration
- **Status** — built-in Status

Recommended board columns: Todo → In Progress → In Review → Done.

Recommended iterations:
- Sprint 1: 19 Oct – 23 Oct 2026
- Sprint 2: 26 Oct – 30 Oct 2026

The 30 consolidated SRS-derived backlog issues are #20–#49. The issue's GitHub assignee is the source of truth for active ownership; this document records the agreed planning allocation.

## Development workflow

1. Team member works on an assigned issue.
2. Create a feature branch.
3. Commit implementation and tests.
4. Raise a pull request referencing the issue.
5. GitHub Actions runs the BMS CI checks.
6. Teammates review the PR from their own GitHub accounts.
7. Repository owner reviews the PR and merges only after approval and passing checks.
8. Move the Project item to Done after implementation and verification.
