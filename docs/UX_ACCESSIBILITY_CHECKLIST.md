# Usability and Accessibility Checklist — BMS-NF-005 / TC-UX-01

BMS-NF-005 requires clear validation, readable labels and accessible navigation, with acceptance by an "agreed checklist". The submitted documents do not define that checklist, so this one is **proposed**: the Product Owner and QA Lead should confirm or amend it, then the Test Engineer records results in the Result column.

Target: WCAG 2.1 Level AA, on the current desktop versions of Chrome, Firefox, Safari and Edge, and on a phone-width window.

## Automated evidence (already run)

| Check | Result |
| --- | --- |
| axe-core rules (login page, customer dashboard, staff dashboard), excluding colour contrast | 0 violations |
| Colour contrast of text pairs, calculated from `styles.css` | All at least 4.5:1 (lowest: muted text on page background, 4.63:1) |
| Form-field border contrast | 3.65:1 against white (was 1.48:1, below the 3:1 minimum) |
| Regression tests in `tests/api.test.js` (labels, autocomplete, live regions, captions, focus style, contrast) | Pass in CI |

axe was run in a simulated browser without a layout engine, so it cannot judge rendered contrast, focus order or zoom. The manual items below cover those.

## Manual checklist (Test Engineer)

| # | Check | How | Result |
| --- | --- | --- | --- |
| 1 | Keyboard only | Complete login, deposit, transfer and a loan application using Tab, Shift+Tab, Enter and Space only. Every control is reachable and operable. | |
| 2 | Skip link | Press Tab once on page load. "Skip to main content" appears; Enter moves focus past the header. | |
| 3 | Visible focus | The focused control always has a clear ring, including on the dark header and account cards. | |
| 4 | Focus management | After "Continue to OTP" focus is in the OTP field; after login focus is on the welcome heading. | |
| 5 | Validation messages | Submit each form empty or with bad values (for example amount 0, short loan purpose, From date after To date). The message says what is wrong and stays visible for several seconds. | |
| 6 | Errors are announced | With a screen reader (VoiceOver on macOS: Cmd+F5), a wrong password and a rejected transfer are read out without moving focus. | |
| 7 | Labels | With the screen reader, each field is announced with its label; the Remove buttons announce the beneficiary name. | |
| 8 | Tables | Transaction, loan and audit tables announce their caption and column headers, and scroll sideways with the keyboard on a narrow window. | |
| 9 | Zoom and reflow | At 200% browser zoom and at 320 px width nothing is cut off and there is no sideways page scroll (tables scroll inside their own region). | |
| 10 | Browsers | Items 1, 5 and 9 pass in Chrome, Firefox, Safari and Edge. | |
| 11 | Colour independence | Success and failure are distinguishable without colour (the text says "Error:" or the status word). | |

Record failures as GitHub issues linked to BMS-NF-005.
