# Data Encryption Verification

This runbook completes the local evidence step for BMS-NF-003 after the encrypted-persistence implementation is merged.

## 1. Set a local encryption key

PowerShell:

```powershell
$env:BMS_STORE_ENCRYPTION_KEY = (node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
```

The key is kept only in the current shell and must not be committed to GitHub.

## 2. Start the persistent demo

```powershell
$env:BMS_PERSISTENCE="true"
npm start
```

The server should start because a valid encryption key is present.

## 3. Generate persisted data

Log in and perform at least one normal operation such as a deposit or profile update.

## 4. Verify the data file

Open:

```text
backend/data/db.json
```

The file should begin with:

```text
enc:v1:
```

It must not contain readable JSON fields such as `"users"`, `"accounts"`, or the demo email.

Capture a screenshot for Issue #42, making sure the encryption key is not visible anywhere.

## 5. Restart/decrypt test

Stop the server with Ctrl+C and run `npm start` again in the same shell. The previously created data should still be available.

## 6. Wrong-key protection

Stop the server and set a different random key:

```powershell
$env:BMS_STORE_ENCRYPTION_KEY = (node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
npm start
```

Startup should fail instead of replacing/resetting the encrypted store.

## 7. Automated verification

The repository regression suite already checks:
- missing encryption key
- short encryption key
- encrypted-at-rest file format
- successful decryption
- wrong-key protection
- plaintext-store migration to encrypted storage

CI must be green before Issue #42 is marked Done.
