const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BMS_PERSISTENCE = "false";
process.env.BMS_DEMO_MODE = "true";

const { createApp } = require("../backend/server");

async function start(t) {
  const app = createApp({ freshStore: true });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, base: "http://127.0.0.1:" + server.address().port };
}

async function post(base, path, body, token, extraHeaders = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
}

async function get(base, path, token) {
  return fetch(base + path, {
    headers: token ? { authorization: "Bearer " + token } : {}
  });
}

async function loginAs(base, email = "customer@bms.local") {
  const login = await post(base, "/api/auth/login", { email, password: "Password@123" });
  assert.equal(login.status, 200, "password login should succeed");
  const loginBody = await login.json();
  assert.equal(loginBody.requiresOtp, true);
  const verify = await post(base, "/api/auth/verify-otp", {
    userId: loginBody.userId,
    otp: "123456"
  });
  assert.equal(verify.status, 200, "demo OTP should be accepted");
  const body = await verify.json();
  assert.ok(body.token);
  return body.token;
}

async function accountBalance(base, token, accountId = "acc-1001") {
  const response = await get(base, "/api/accounts", token);
  assert.equal(response.status, 200);
  const body = await response.json();
  const account = body.accounts.find(item => item.id === accountId);
  return account ? account.balance : null;
}

async function accountTransactions(base, token, accountId = "acc-1001") {
  const response = await get(base, "/api/transactions?accountId=" + encodeURIComponent(accountId), token);
  assert.equal(response.status, 200);
  return (await response.json()).transactions;
}

test("health endpoint responds", async t => {
  const { base } = await start(t);
  const response = await get(base, "/api/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
});

test("customer can authenticate with password and OTP", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  assert.ok(token);
});

test("authenticated customer can deposit, withdraw and transfer", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);

  const deposit = await post(base, "/api/transactions/deposit", {
    accountId: "acc-1001", amount: 250
  }, token, { "Idempotency-Key": "test-deposit-core-001" });
  assert.equal(deposit.status, 201);

  const depositBody = await deposit.json();
  assert.equal(depositBody.transaction.type, "DEPOSIT");
  assert.equal(depositBody.transaction.amount, 250);
  assert.equal(depositBody.transaction.balanceAfter, 10250);
  assert.equal(depositBody.account.balance, 10250);

  const withdrawal = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-1001", amount: 100
  }, token, { "Idempotency-Key": "test-withdraw-core-001" });
  assert.equal(withdrawal.status, 201);

  const transfer = await post(base, "/api/transactions/transfer", {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 500
  }, token, { "Idempotency-Key": "test-transfer-core-001" });
  assert.equal(transfer.status, 201);

  assert.equal(await accountBalance(base, token), 9650);
  const transactions = await accountTransactions(base, token);
  assert.ok(transactions.some(item => item.type === "WITHDRAWAL" && item.amount === 100));
});

test("balance inquiry only displays customer-owned accounts", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const response = await get(base, "/api/accounts", token);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.accounts.map(account => account.id).sort(), ["acc-1001", "acc-1002"]);
  assert.equal(body.accounts.find(account => account.id === "acc-1001").balance, 10000);
  assert.equal(body.accounts.some(account => account.id === "acc-2001"), false);
});

test("zero, negative, missing-account and insufficient-funds withdrawals are rejected without debiting", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const cases = [
    { name: "zero", body: { accountId: "acc-1001", amount: 0 }, status: 400 },
    { name: "negative", body: { accountId: "acc-1001", amount: -1 }, status: 400 },
    { name: "missing-account-id", body: { amount: 50 }, status: 404 },
    { name: "insufficient-funds", body: { accountId: "acc-1001", amount: 999999 }, status: 400 }
  ];

  for (const item of cases) {
    const response = await post(base, "/api/transactions/withdraw", item.body, token, {
      "Idempotency-Key": "test-withdraw-" + item.name
    });
    assert.equal(response.status, item.status, item.name + " should be rejected");
    assert.equal(await accountBalance(base, token), 10000, item.name + " must not change balance");
  }

  const transactions = await accountTransactions(base, token);
  assert.equal(transactions.filter(item => item.type === "WITHDRAWAL").length, 0);
});

test("withdrawal without an idempotency key is rejected without debiting", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const response = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-1001", amount: 100
  }, token);
  assert.equal(response.status, 400);
  assert.equal(await accountBalance(base, token), 10000);
  assert.equal((await accountTransactions(base, token)).filter(item => item.type === "WITHDRAWAL").length, 0);
});

test("customer cannot withdraw from another customer's account", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const response = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-2001", amount: 100
  }, customerToken, { "Idempotency-Key": "test-withdraw-unauthorized-001" });
  assert.equal(response.status, 403);
  assert.equal(await accountBalance(base, customerToken), 10000);

  const staffToken = await loginAs(base, "staff@bms.local");
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25000);
  const transactions = await accountTransactions(base, staffToken, "acc-2001");
  assert.equal(transactions.filter(item => item.type === "WITHDRAWAL").length, 0);
});

test("retrying the same withdrawal key applies exactly one debit and creates one transaction", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const body = { accountId: "acc-1001", amount: 100 };
  const headers = { "Idempotency-Key": "test-withdraw-retry-001" };

  const first = await post(base, "/api/transactions/withdraw", body, token, headers);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.transaction.type, "WITHDRAWAL");

  // Simulates the client retrying the same request after a timeout/lost response.
  const retry = await post(base, "/api/transactions/withdraw", body, token, headers);
  assert.equal(retry.status, 201);
  const retryBody = await retry.json();
  assert.equal(retryBody.idempotentReplay, true);
  assert.equal(retryBody.transaction.id, firstBody.transaction.id);

  assert.equal(await accountBalance(base, token), 9900);
  const transactions = await accountTransactions(base, token);
  const withdrawals = transactions.filter(item => item.type === "WITHDRAWAL");
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].id, firstBody.transaction.id);
});

test("reusing a withdrawal key with a different request returns conflict", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const key = { "Idempotency-Key": "test-withdraw-conflict-001" };
  const first = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-1001", amount: 100
  }, token, key);
  assert.equal(first.status, 201);

  const conflict = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-1001", amount: 200
  }, token, key);
  assert.equal(conflict.status, 409);
  assert.equal(await accountBalance(base, token), 9900);
  assert.equal((await accountTransactions(base, token)).filter(item => item.type === "WITHDRAWAL").length, 1);
});

test("successful and rejected withdrawal attempts are audited without passwords or OTP values", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const success = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-1001", amount: 50
  }, customerToken, { "Idempotency-Key": "test-withdraw-audit-001" });
  assert.equal(success.status, 201);

  const rejected = await post(base, "/api/transactions/withdraw", {
    accountId: "acc-1001", amount: 0
  }, customerToken, { "Idempotency-Key": "test-withdraw-audit-002" });
  assert.equal(rejected.status, 400);

  const staffToken = await loginAs(base, "staff@bms.local");
  const auditResponse = await get(base, "/api/admin/audit", staffToken);
  assert.equal(auditResponse.status, 200);
  const logs = (await auditResponse.json()).auditLogs;
  assert.ok(logs.some(log => log.action === "CASH_WITHDRAWAL" && log.userId === "usr-customer-001"));
  assert.ok(logs.some(log => log.action === "CASH_WITHDRAWAL_REJECTED" && log.metadata.reason === "INVALID_AMOUNT"));
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("Password@123"), false);
  assert.equal(serializedLogs.includes("123456"), false);
});


test("customer can apply for a loan and staff can approve it with a repayment schedule", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const application = await post(base, "/api/loans", {
    amount: 12000,
    tenureMonths: 12,
    purpose: "Home appliance purchase"
  }, customerToken);
  assert.equal(application.status, 201);
  const applicationBody = await application.json();
  assert.equal(applicationBody.loan.status, "PENDING");
  assert.equal(applicationBody.loan.amount, 12000);

  const customerLoans = await get(base, "/api/loans", customerToken);
  assert.equal(customerLoans.status, 200);
  assert.equal((await customerLoans.json()).loans.length, 1);

  const staffToken = await loginAs(base, "staff@bms.local");
  const decision = await fetch(base + "/api/loans/" + applicationBody.loan.id + "/decision", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify({ decision: "APPROVED", annualRatePercent: 12, disbursementAccountId: "acc-1001" })
  });
  assert.equal(decision.status, 200);
  const loan = (await decision.json()).loan;
  assert.equal(loan.status, "APPROVED");
  assert.ok(loan.outstandingBalance > 12000);
  assert.ok(loan.repaymentAmount > 1000);
  assert.equal(await accountBalance(base, customerToken), 22000);
  const customerTransactions = await accountTransactions(base, customerToken);
  assert.ok(customerTransactions.some(item => item.type === "LOAN_DISBURSEMENT" && item.amount === 12000));
});

test("loan repayment debits the account, reduces outstanding balance and enters transaction history", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const application = await post(base, "/api/loans", {
    amount: 6000, tenureMonths: 6, purpose: "Education fees"
  }, customerToken);
  const loan = (await application.json()).loan;

  const staffToken = await loginAs(base, "staff@bms.local");
  const decision = await fetch(base + "/api/loans/" + loan.id + "/decision", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify({ decision: "APPROVED", annualRatePercent: 0, disbursementAccountId: "acc-1001" })
  });
  assert.equal(decision.status, 200);

  const repayment = await post(base, "/api/loans/" + loan.id + "/repayments", {
    accountId: "acc-1001", amount: 1500
  }, customerToken, { "Idempotency-Key": "loan-repay-happy-001" });
  assert.equal(repayment.status, 201);
  const repaymentBody = await repayment.json();
  assert.equal(repaymentBody.loan.outstandingBalance, 4500);
  assert.equal(repaymentBody.account.balance, 14500);
  assert.equal(repaymentBody.transaction.type, "LOAN_REPAYMENT");

  const transactions = await accountTransactions(base, customerToken);
  assert.ok(transactions.some(item => item.type === "LOAN_REPAYMENT" && item.amount === 1500));
});

test("invalid and unauthorized loan operations do not alter balances or loan status", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const application = await post(base, "/api/loans", {
    amount: 2000, tenureMonths: 12, purpose: "Medical expenses"
  }, customerToken);
  const loan = (await application.json()).loan;

  const customerDecision = await fetch(base + "/api/loans/" + loan.id + "/decision", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + customerToken },
    body: JSON.stringify({ decision: "APPROVED", annualRatePercent: 0, disbursementAccountId: "acc-1001" })
  });
  assert.equal(customerDecision.status, 403);

  const staffToken = await loginAs(base, "staff@bms.local");
  const approval = await fetch(base + "/api/loans/" + loan.id + "/decision", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify({ decision: "APPROVED", annualRatePercent: 0, disbursementAccountId: "acc-1001" })
  });
  assert.equal(approval.status, 200);

  const overpayment = await post(base, "/api/loans/" + loan.id + "/repayments", {
    accountId: "acc-1001", amount: 999999
  }, customerToken, { "Idempotency-Key": "loan-repay-overpayment-001" });
  assert.equal(overpayment.status, 400);
  assert.equal(await accountBalance(base, customerToken), 12000);

  const noAccount = await post(base, "/api/loans/" + loan.id + "/repayments", {
    amount: 50
  }, customerToken, { "Idempotency-Key": "loan-repay-no-account-001" });
  assert.equal(noAccount.status, 404);
  assert.equal(await accountBalance(base, customerToken), 12000);
});

test("operational report is staff-only and returns aggregate banking metrics", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const denied = await get(base, "/api/admin/reports/summary", customerToken);
  assert.equal(denied.status, 403);

  const staffToken = await loginAs(base, "staff@bms.local");
  const reportResponse = await get(base, "/api/admin/reports/summary", staffToken);
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.accounts.total, 3);
  assert.equal(report.accounts.active, 3);
  assert.equal(report.transactions.total, 0);
  assert.equal(report.loans.total, 0);
  assert.equal(report.scope, "CURRENT_LOCAL_DEMO_STORE");
  assert.ok(report.generatedAt);
});

test("authentication failures are audited without logging credentials or OTPs; audit endpoint is staff-only", async t => {
  const { base } = await start(t);
  const failedLogin = await post(base, "/api/auth/login", {
    email: "customer@bms.local", password: "Wrong-Password-Secret"
  });
  assert.equal(failedLogin.status, 401);

  const failedOtp = await post(base, "/api/auth/verify-otp", {
    userId: "usr-customer-001", otp: "wrong-otp-value"
  });
  assert.equal(failedOtp.status, 401);

  const customerToken = await loginAs(base);
  const denied = await get(base, "/api/admin/audit", customerToken);
  assert.equal(denied.status, 403);

  const staffToken = await loginAs(base, "staff@bms.local");
  const response = await get(base, "/api/admin/audit", staffToken);
  assert.equal(response.status, 200);
  const logs = (await response.json()).auditLogs;
  assert.ok(logs.some(log => log.action === "AUTHENTICATION_FAILED" && log.metadata.reason === "INVALID_PASSWORD"));
  assert.ok(logs.some(log => log.action === "OTP_VERIFICATION_FAILED" && log.metadata.reason === "OTP_NOT_FOUND"));
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("Wrong-Password-Secret"), false);
  assert.equal(serialized.includes("wrong-otp-value"), false);
  assert.equal(serialized.includes("Password@123"), false);
  assert.equal(serialized.includes("123456"), false);
});


test("retrying a loan repayment with the same idempotency key debits only once", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const application = await post(base, "/api/loans", {
    amount: 2000, tenureMonths: 4, purpose: "Short term expense"
  }, customerToken);
  const loan = (await application.json()).loan;

  const staffToken = await loginAs(base, "staff@bms.local");
  const approval = await fetch(base + "/api/loans/" + loan.id + "/decision", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify({ decision: "APPROVED", annualRatePercent: 0, disbursementAccountId: "acc-1001" })
  });
  assert.equal(approval.status, 200);
  const body = { accountId: "acc-1001", amount: 500 };
  const headers = { "Idempotency-Key": "loan-repay-retry-001" };

  const first = await post(base, "/api/loans/" + loan.id + "/repayments", body, customerToken, headers);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const retry = await post(base, "/api/loans/" + loan.id + "/repayments", body, customerToken, headers);
  assert.equal(retry.status, 201);
  const retryBody = await retry.json();
  assert.equal(retryBody.idempotentReplay, true);
  assert.equal(retryBody.transaction.id, firstBody.transaction.id);

  assert.equal(await accountBalance(base, customerToken), 11500);
  const transactions = await accountTransactions(base, customerToken);
  assert.equal(transactions.filter(item => item.type === "LOAN_REPAYMENT").length, 1);
});

// ---- BMS-F-007 / issue #26: cash deposit ----

test("invalid deposits are rejected without changing balance or creating transactions", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);

  const invalidCases = [
    { name: "zero amount", status: 400, body: { accountId: "acc-1001", amount: 0 } },
    { name: "negative amount", status: 400, body: { accountId: "acc-1001", amount: -10 } },
    { name: "missing amount", status: 400, body: { accountId: "acc-1001" } },
    { name: "missing account", status: 404, body: { amount: 100 } },
    { name: "unknown account", status: 404, body: { accountId: "missing-account", amount: 100 } }
  ];

  for (const [index, item] of invalidCases.entries()) {
    const response = await post(base, "/api/transactions/deposit", item.body, token, {
      "Idempotency-Key": "test-deposit-invalid-" + index
    });
    assert.equal(response.status, item.status, item.name + ": unexpected status");
    assert.equal(await accountBalance(base, token), 10000, item.name + " must not change the balance");
  }

  const transactions = await accountTransactions(base, token);
  assert.equal(
    transactions.filter(item => item.type === "DEPOSIT").length,
    0,
    "Rejected deposits must not create deposit transactions"
  );
});

test("customer cannot deposit into another customer's account", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");

  const response = await post(base, "/api/transactions/deposit", {
    accountId: "acc-2001",
    amount: 500
  }, customerToken, { "Idempotency-Key": "test-deposit-foreign-001" });

  assert.equal(response.status, 403);
  assert.equal(await accountBalance(base, customerToken), 10000);
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25000);

  const staffTransactions = await accountTransactions(base, staffToken, "acc-2001");
  assert.equal(staffTransactions.filter(item => item.type === "DEPOSIT").length, 0);
});

test("deposit without an idempotency key is rejected without crediting", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const response = await post(base, "/api/transactions/deposit", {
    accountId: "acc-1001", amount: 100
  }, token);
  assert.equal(response.status, 400);
  assert.equal(await accountBalance(base, token), 10000);
  assert.equal((await accountTransactions(base, token)).filter(item => item.type === "DEPOSIT").length, 0);
});

test("retrying the same deposit key credits exactly once and creates one transaction", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const body = { accountId: "acc-1001", amount: 100 };
  const headers = { "Idempotency-Key": "test-deposit-retry-001" };

  const first = await post(base, "/api/transactions/deposit", body, token, headers);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.transaction.type, "DEPOSIT");

  // Simulates the client retrying the same request after a timeout/lost response.
  const retry = await post(base, "/api/transactions/deposit", body, token, headers);
  assert.equal(retry.status, 201);
  const retryBody = await retry.json();
  assert.equal(retryBody.idempotentReplay, true);
  assert.equal(retryBody.transaction.id, firstBody.transaction.id);

  assert.equal(await accountBalance(base, token), 10100);
  const deposits = (await accountTransactions(base, token)).filter(item => item.type === "DEPOSIT");
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].id, firstBody.transaction.id);
});

test("reusing a deposit key with a different request returns conflict", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const key = { "Idempotency-Key": "test-deposit-conflict-001" };
  const first = await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 100 }, token, key);
  assert.equal(first.status, 201);

  const conflict = await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 200 }, token, key);
  assert.equal(conflict.status, 409);
  assert.equal(await accountBalance(base, token), 10100);
  assert.equal((await accountTransactions(base, token)).filter(item => item.type === "DEPOSIT").length, 1);
});

test("successful, replayed and rejected deposits are audited without passwords or OTP values", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const body = { accountId: "acc-1001", amount: 50 };
  const headers = { "Idempotency-Key": "test-deposit-audit-001" };
  assert.equal((await post(base, "/api/transactions/deposit", body, customerToken, headers)).status, 201);
  assert.equal((await post(base, "/api/transactions/deposit", body, customerToken, headers)).status, 201);
  const rejected = await post(base, "/api/transactions/deposit", {
    accountId: "acc-1001", amount: 0
  }, customerToken, { "Idempotency-Key": "test-deposit-audit-002" });
  assert.equal(rejected.status, 400);

  const staffToken = await loginAs(base, "staff@bms.local");
  const auditResponse = await get(base, "/api/admin/audit", staffToken);
  assert.equal(auditResponse.status, 200);
  const logs = (await auditResponse.json()).auditLogs;
  assert.ok(logs.some(log => log.action === "CASH_DEPOSIT" && log.userId === "usr-customer-001"));
  assert.ok(logs.some(log => log.action === "CASH_DEPOSIT_IDEMPOTENT_REPLAY"));
  assert.ok(logs.some(log => log.action === "CASH_DEPOSIT_REJECTED" && log.metadata.reason === "INVALID_AMOUNT"));
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("Password@123"), false);
  assert.equal(serializedLogs.includes("123456"), false);
  assert.equal(serializedLogs.includes("test-deposit-audit-001"), false, "raw idempotency keys must not be logged");
});

// ---- BMS-F-009 / issue #28: fund transfer ----

const TRANSFER = "/api/transactions/transfer";
const countType = (list, type) => list.filter(item => item.type === type).length;

async function assertBalancesUnchanged(base, customerToken, staffToken, message) {
  assert.equal(await accountBalance(base, customerToken, "acc-1001"), 10000, message + ": acc-1001");
  assert.equal(await accountBalance(base, customerToken, "acc-1002"), 5000, message + ": acc-1002");
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25000, message + ": acc-2001");
}

test("successful transfer debits source, credits destination and writes both ledger entries", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");

  const response = await post(base, TRANSFER, {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 500
  }, customerToken, { "Idempotency-Key": "test-transfer-ledger-001" });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.transaction.type, "TRANSFER_OUT");
  assert.equal(body.transaction.balanceAfter, 9500);
  assert.equal(body.account.balance, 9500);

  assert.equal(await accountBalance(base, customerToken, "acc-1001"), 9500);
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25500);
  // Money is conserved across all three seeded accounts.
  const total = 9500 + (await accountBalance(base, customerToken, "acc-1002")) + 25500;
  assert.equal(total, 40000);

  const outbound = await accountTransactions(base, customerToken, "acc-1001");
  const inbound = await accountTransactions(base, staffToken, "acc-2001");
  assert.equal(countType(outbound, "TRANSFER_OUT"), 1);
  assert.equal(countType(inbound, "TRANSFER_IN"), 1);
  assert.equal(inbound.find(item => item.type === "TRANSFER_IN").balanceAfter, 25500);
});

test("invalid transfers are rejected without changing any balance or creating transactions", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");

  const cases = [
    { name: "zero amount", status: 400, body: { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 0 } },
    { name: "negative amount", status: 400, body: { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: -5 } },
    { name: "missing amount", status: 400, body: { fromAccountId: "acc-1001", toAccountNumber: "1000002001" } },
    { name: "missing destination", status: 404, body: { fromAccountId: "acc-1001", amount: 100 } },
    { name: "unknown destination", status: 404, body: { fromAccountId: "acc-1001", toAccountNumber: "0000000000", amount: 100 } },
    { name: "same source and destination", status: 400, body: { fromAccountId: "acc-1001", toAccountNumber: "1000001001", amount: 100 } },
    { name: "unknown source", status: 404, body: { fromAccountId: "missing-account", toAccountNumber: "1000002001", amount: 100 } },
    { name: "another customer's source account", status: 403, body: { fromAccountId: "acc-2001", toAccountNumber: "1000001001", amount: 100 } },
    { name: "insufficient balance", status: 400, body: { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 10001 } },
    { name: "over the transfer limit", status: 400, body: { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 200001 } }
  ];

  for (const [index, item] of cases.entries()) {
    const response = await post(base, TRANSFER, item.body, customerToken, {
      "Idempotency-Key": "test-transfer-invalid-" + index
    });
    assert.equal(response.status, item.status, item.name + ": unexpected status");
    await assertBalancesUnchanged(base, customerToken, staffToken, item.name);
  }

  for (const [token, accountId] of [[customerToken, "acc-1001"], [customerToken, "acc-1002"], [staffToken, "acc-2001"]]) {
    const list = await accountTransactions(base, token, accountId);
    assert.equal(countType(list, "TRANSFER_OUT") + countType(list, "TRANSFER_IN"), 0, accountId + " must have no transfer entries");
  }
});

test("transfer to a frozen account is rejected without moving money", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");

  const freeze = await fetch(base + "/api/accounts/acc-2001/lifecycle", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify({ status: "FROZEN" })
  });
  assert.equal(freeze.status, 200);

  const response = await post(base, TRANSFER, {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 100
  }, customerToken, { "Idempotency-Key": "test-transfer-frozen-001" });
  assert.equal(response.status, 400);
  assert.equal(await accountBalance(base, customerToken, "acc-1001"), 10000);
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25000);
});

test("transfer without an idempotency key is rejected without moving money", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const response = await post(base, TRANSFER, {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 100
  }, customerToken);
  assert.equal(response.status, 400);
  await assertBalancesUnchanged(base, customerToken, staffToken, "missing key");
});

test("retrying the same transfer key moves the money exactly once", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const body = { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 500 };
  const headers = { "Idempotency-Key": "test-transfer-retry-001" };

  const first = await post(base, TRANSFER, body, customerToken, headers);
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  // Simulates the client retrying the same request after a timeout/lost response.
  const retry = await post(base, TRANSFER, body, customerToken, headers);
  assert.equal(retry.status, 201);
  const retryBody = await retry.json();
  assert.equal(retryBody.idempotentReplay, true);
  assert.equal(retryBody.transaction.id, firstBody.transaction.id);

  assert.equal(await accountBalance(base, customerToken, "acc-1001"), 9500);
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25500);
  assert.equal(countType(await accountTransactions(base, customerToken, "acc-1001"), "TRANSFER_OUT"), 1);
  assert.equal(countType(await accountTransactions(base, staffToken, "acc-2001"), "TRANSFER_IN"), 1);
});

test("reusing a transfer key with a different request returns conflict", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const key = { "Idempotency-Key": "test-transfer-conflict-001" };
  const first = await post(base, TRANSFER, {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 500
  }, customerToken, key);
  assert.equal(first.status, 201);

  const conflict = await post(base, TRANSFER, {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 900
  }, customerToken, key);
  assert.equal(conflict.status, 409);
  assert.equal(await accountBalance(base, customerToken, "acc-1001"), 9500);
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25500);
});

test("successful, replayed and rejected transfers are audited without secrets or raw keys", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const body = { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 50 };
  const headers = { "Idempotency-Key": "test-transfer-audit-001" };
  assert.equal((await post(base, TRANSFER, body, customerToken, headers)).status, 201);
  assert.equal((await post(base, TRANSFER, body, customerToken, headers)).status, 201);
  assert.equal((await post(base, TRANSFER, { ...body, amount: 10001 }, customerToken, { "Idempotency-Key": "test-transfer-audit-002" })).status, 400);
  assert.equal((await post(base, TRANSFER, { ...body, amount: 200001 }, customerToken, { "Idempotency-Key": "test-transfer-audit-003" })).status, 400);

  const staffToken = await loginAs(base, "staff@bms.local");
  const auditResponse = await get(base, "/api/admin/audit", staffToken);
  assert.equal(auditResponse.status, 200);
  const logs = (await auditResponse.json()).auditLogs;
  assert.ok(logs.some(log => log.action === "FUND_TRANSFER" && log.userId === "usr-customer-001"));
  assert.ok(logs.some(log => log.action === "FUND_TRANSFER_IDEMPOTENT_REPLAY"));
  assert.ok(logs.some(log => log.action === "FUND_TRANSFER_REJECTED" && log.metadata.reason === "INSUFFICIENT_BALANCE"));
  assert.ok(logs.some(log => log.action === "FUND_TRANSFER_REJECTED" && log.metadata.reason === "TRANSFER_LIMIT_EXCEEDED"));
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("Password@123"), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes("test-transfer-audit-001"), false, "raw idempotency keys must not be logged");
});

// ---- BMS-F-011 / issue #30: transaction history ----

const HISTORY = "/api/transactions";

async function history(base, token, query) {
  const response = await get(base, HISTORY + query, token);
  return { status: response.status, body: await response.json() };
}

test("history for an account returns only that account's entries and never the other party's row", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const transfer = await post(base, "/api/transactions/transfer", {
    fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 500
  }, customerToken, { "Idempotency-Key": "test-history-scope-001" });
  assert.equal(transfer.status, 201);

  const selected = await history(base, customerToken, "?accountId=acc-1001");
  assert.equal(selected.status, 200);
  assert.equal(selected.body.transactions.length, 1);
  assert.ok(selected.body.transactions.every(item => item.accountId === "acc-1001"));
  assert.equal(JSON.stringify(selected.body).includes("25500"), false, "must not expose the other account's balance");

  const all = await history(base, customerToken, "");
  assert.ok(all.body.transactions.every(item => ["acc-1001", "acc-1002"].includes(item.accountId)));

  // The receiving account still sees its own side of the transfer.
  const receiving = await history(base, staffToken, "?accountId=acc-2001");
  assert.equal(receiving.body.transactions.length, 1);
  assert.equal(receiving.body.transactions[0].type, "TRANSFER_IN");
});

test("history selected by account separates a customer's own accounts", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const transfer = await post(base, "/api/transactions/transfer", {
    fromAccountId: "acc-1001", toAccountNumber: "1000001002", amount: 200
  }, token, { "Idempotency-Key": "test-history-own-001" });
  assert.equal(transfer.status, 201);

  const first = await history(base, token, "?accountId=acc-1001");
  const second = await history(base, token, "?accountId=acc-1002");
  assert.deepEqual(first.body.transactions.map(item => item.type), ["TRANSFER_OUT"]);
  assert.deepEqual(second.body.transactions.map(item => item.type), ["TRANSFER_IN"]);
});

test("history date range is inclusive at both ends and excludes anything outside it", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const deposit = await post(base, "/api/transactions/deposit", {
    accountId: "acc-1001", amount: 100
  }, token, { "Idempotency-Key": "test-history-range-001" });
  assert.equal(deposit.status, 201);
  const created = (await deposit.json()).transaction.createdAt;
  const at = Date.parse(created);
  const iso = ms => new Date(ms).toISOString();
  const account = "accountId=acc-1001";

  const count = async query => (await history(base, token, "?" + account + query)).body.transactions.length;
  assert.equal(await count("&from=" + created + "&to=" + created), 1, "exact boundaries are inclusive");
  assert.equal(await count("&from=" + iso(at + 1)), 0, "from just after the entry excludes it");
  assert.equal(await count("&to=" + iso(at - 1)), 0, "to just before the entry excludes it");
  assert.equal(await count("&from=" + iso(at - 1000) + "&to=" + iso(at + 1000)), 1);
  assert.equal(await count("&from=" + iso(at - 1000)), 1, "open-ended to");
  assert.equal(await count("&to=" + iso(at + 1000)), 1, "open-ended from");
  assert.equal(await count("&from=2020-01-01&to=2020-01-02"), 0, "a past date range returns nothing");

  const day = created.slice(0, 10);
  assert.equal(await count("&from=" + day + "&to=" + day), 1, "a date-only range covers the whole day");
});

test("invalid history filters are rejected with 400", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  const invalid = [
    "?from=not-a-date",
    "?to=2026-13-45",
    "?from=2026-02-31",
    "?from=2026-10-20&to=2026-10-10",
    "?from=2026-10-01&from=2026-10-02",
    "?to=1"
  ];
  for (const query of invalid) {
    const response = await history(base, token, query);
    assert.equal(response.status, 400, query + " should be rejected");
    assert.equal(response.body.transactions, undefined);
  }
});

test("history cannot be read for another customer's account or without logging in", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);
  assert.equal((await history(base, token, "?accountId=acc-2001")).status, 403);
  const anonymous = await fetch(base + HISTORY + "?accountId=acc-1001");
  assert.equal(anonymous.status, 401);
});

// ---- BMS-F-014 / issue #33: loan approval, rejection and return ----

async function applyForLoan(base, token, amount = 3000) {
  const response = await post(base, "/api/loans", {
    amount, tenureMonths: 12, purpose: "Home appliance purchase"
  }, token);
  assert.equal(response.status, 201);
  return (await response.json()).loan;
}

async function decideLoan(base, staffToken, loanId, body) {
  const response = await fetch(base + "/api/loans/" + loanId + "/decision", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function loanFor(base, token, loanId) {
  const response = await get(base, "/api/loans", token);
  return (await response.json()).loans.find(item => item.id === loanId);
}

test("rejecting a loan records who, when and why, and moves no money", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);

  const result = await decideLoan(base, staffToken, loan.id, { decision: "REJECTED", reason: "Insufficient income proof" });
  assert.equal(result.status, 200);
  assert.equal(result.body.loan.status, "REJECTED");
  assert.equal(result.body.loan.decidedBy, "usr-staff-001");
  assert.equal(result.body.loan.decisionReason, "Insufficient income proof");
  assert.ok(!Number.isNaN(Date.parse(result.body.loan.decisionAt)));
  assert.equal(result.body.transaction, null);

  assert.equal(await accountBalance(base, customerToken), 10000);
  const entries = await accountTransactions(base, customerToken);
  assert.equal(entries.filter(item => item.type === "LOAN_DISBURSEMENT").length, 0);

  // The applicant can see the outcome and the reason.
  const seen = await loanFor(base, customerToken, loan.id);
  assert.equal(seen.status, "REJECTED");
  assert.equal(seen.decisionReason, "Insufficient income proof");

  // Audit trail records the staff user, decision and reason.
  const logs = (await (await get(base, "/api/admin/audit", staffToken)).json()).auditLogs;
  const entry = logs.find(log => log.action === "LOAN_APPLICATION_DECIDED" && log.metadata.loanId === loan.id);
  assert.ok(entry);
  assert.equal(entry.userId, "usr-staff-001");
  assert.equal(entry.metadata.decision, "REJECTED");
  assert.equal(entry.metadata.reason, "Insufficient income proof");
});

test("returning a loan to the applicant records the reason, blocks repayment and moves no money", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);

  const result = await decideLoan(base, staffToken, loan.id, { decision: "RETURNED", reason: "Please attach salary slips" });
  assert.equal(result.status, 200);
  assert.equal(result.body.loan.status, "RETURNED");
  assert.equal(result.body.loan.decidedBy, "usr-staff-001");
  assert.equal(result.body.loan.decisionReason, "Please attach salary slips");
  assert.equal(await accountBalance(base, customerToken), 10000);

  const repayment = await post(base, "/api/loans/" + loan.id + "/repayments", {
    accountId: "acc-1001", amount: 100
  }, customerToken, { "Idempotency-Key": "loan-returned-repay-001" });
  assert.ok(repayment.status >= 400, "a returned application cannot be repaid");
  assert.equal(await accountBalance(base, customerToken), 10000);

  const logs = (await (await get(base, "/api/admin/audit", staffToken)).json()).auditLogs;
  assert.ok(logs.some(log => log.action === "LOAN_APPLICATION_DECIDED" && log.metadata.decision === "RETURNED" && log.metadata.reason === "Please attach salary slips"));
});

test("approving a loan records the deciding staff user and time, with an optional reason", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);

  const result = await decideLoan(base, staffToken, loan.id, {
    decision: "APPROVED", annualRatePercent: 10, disbursementAccountId: "acc-1001", reason: "Meets income criteria"
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.loan.status, "APPROVED");
  assert.equal(result.body.loan.decidedBy, "usr-staff-001");
  assert.equal(result.body.loan.decisionReason, "Meets income criteria");
  assert.ok(!Number.isNaN(Date.parse(result.body.loan.decisionAt)));
  assert.equal(await accountBalance(base, customerToken), 13000);

  // A reason is optional on approval.
  const second = await applyForLoan(base, customerToken, 1000);
  const plain = await decideLoan(base, staffToken, second.id, {
    decision: "APPROVED", annualRatePercent: 0, disbursementAccountId: "acc-1001"
  });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.loan.decisionReason, null);
});

test("rejecting or returning without a valid reason is refused and the loan stays pending", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);

  const invalid = [
    { decision: "REJECTED" },
    { decision: "REJECTED", reason: "" },
    { decision: "REJECTED", reason: "no" },
    { decision: "RETURNED", reason: "    " },
    { decision: "RETURNED", reason: 12345 },
    { decision: "REJECTED", reason: "x".repeat(241) },
    { decision: "APPROVED", annualRatePercent: 5, disbursementAccountId: "acc-1001", reason: "y".repeat(241) },
    { decision: "PENDING", reason: "Not a decision" },
    { decision: "approved", annualRatePercent: 5, disbursementAccountId: "acc-1001" },
    {}
  ];
  for (const body of invalid) {
    const result = await decideLoan(base, staffToken, loan.id, body);
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 60) + " should be rejected");
  }
  assert.equal((await loanFor(base, customerToken, loan.id)).status, "PENDING");
  assert.equal(await accountBalance(base, customerToken), 10000);
});

test("a decided loan cannot be decided again, so approval disburses exactly once", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);
  const approval = { decision: "APPROVED", annualRatePercent: 0, disbursementAccountId: "acc-1001" };

  assert.equal((await decideLoan(base, staffToken, loan.id, approval)).status, 200);
  assert.equal((await decideLoan(base, staffToken, loan.id, approval)).status, 409);
  assert.equal((await decideLoan(base, staffToken, loan.id, { decision: "REJECTED", reason: "Changed my mind" })).status, 409);
  assert.equal(await accountBalance(base, customerToken), 13000);
  const entries = await accountTransactions(base, customerToken);
  assert.equal(entries.filter(item => item.type === "LOAN_DISBURSEMENT").length, 1);
  assert.equal((await loanFor(base, customerToken, loan.id)).status, "APPROVED");
});

test("customers cannot decide loans and unknown loans return 404", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);

  const asCustomer = await decideLoan(base, customerToken, loan.id, { decision: "RETURNED", reason: "Trying to self-return" });
  assert.equal(asCustomer.status, 403);
  assert.equal((await loanFor(base, customerToken, loan.id)).status, "PENDING");
  assert.equal((await decideLoan(base, staffToken, "loan-does-not-exist", { decision: "REJECTED", reason: "No such loan" })).status, 404);
});

test("the operational report counts returned loans separately", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  const loan = await applyForLoan(base, customerToken);
  assert.equal((await decideLoan(base, staffToken, loan.id, { decision: "RETURNED", reason: "Missing documents" })).status, 200);
  const report = await (await get(base, "/api/admin/reports/summary", staffToken)).json();
  assert.equal(report.loans.returned, 1);
  assert.equal(report.loans.pending, 0);
});

// ---- BMS-F-020 / issue #39: audit trail ----

async function auditQuery(base, token, query = "") {
  const response = await get(base, "/api/admin/audit" + query, token);
  return { status: response.status, body: await response.json() };
}

async function generateAuditActivity(base, customerToken, staffToken) {
  const key = suffix => ({ "Idempotency-Key": "test-audit-" + suffix });
  await post(base, "/api/auth/login", { email: "customer@bms.local", password: "WrongPass-Not-Real-1" });
  await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 100 }, customerToken, key("dep-ok-001"));
  await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 100 }, customerToken, key("dep-ok-001"));
  await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 999 }, customerToken, key("dep-ok-001"));
  await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 0 }, customerToken, key("dep-bad-002"));
  await post(base, "/api/transactions/withdraw", { accountId: "acc-1001", amount: 50 }, customerToken, key("wd-ok-001"));
  await post(base, "/api/transactions/transfer", { fromAccountId: "acc-1001", toAccountNumber: "1000002001", amount: 25 }, customerToken, key("tr-ok-001"));
  const loan = await applyForLoan(base, customerToken, 1000);
  await decideLoan(base, staffToken, loan.id, { decision: "REJECTED", reason: "Audit test rejection" });
  await fetch(base + "/api/accounts/acc-1002/lifecycle", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer " + staffToken },
    body: JSON.stringify({ status: "FROZEN" })
  });
  await get(base, "/api/admin/audit", customerToken); // forbidden for customers
}

test("every audit record has user, timestamp, action and a SUCCESS or FAILURE result", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  await generateAuditActivity(base, customerToken, staffToken);

  const { status, body } = await auditQuery(base, staffToken);
  assert.equal(status, 200);
  assert.ok(body.auditLogs.length > 10);
  for (const log of body.auditLogs) {
    assert.match(log.id, /^aud-/);
    assert.equal(typeof log.action, "string");
    assert.ok(!Number.isNaN(Date.parse(log.timestamp)), "valid timestamp");
    assert.ok(["SUCCESS", "FAILURE"].includes(log.result), log.action + " must have a result");
    assert.ok(log.userId === null || typeof log.userId === "string");
  }
  // Records of authenticated financial operations always name the acting user.
  for (const log of body.auditLogs.filter(item => /^(CASH_|FUND_TRANSFER|LOAN_)/.test(item.action))) {
    assert.ok(log.userId, log.action + " must record the user");
  }
});

test("audit results distinguish successful operations from refused or failed attempts", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  await generateAuditActivity(base, customerToken, staffToken);
  const logs = (await auditQuery(base, staffToken)).body.auditLogs;
  const resultOf = action => [...new Set(logs.filter(log => log.action === action).map(log => log.result))];

  for (const action of ["CASH_DEPOSIT", "CASH_WITHDRAWAL", "FUND_TRANSFER", "LOAN_APPLICATION_SUBMITTED", "LOAN_APPLICATION_DECIDED",
    "ACCOUNT_LIFECYCLE_CHANGED", "OTP_VERIFIED", "AUTHENTICATION_SUCCESS_PASSWORD", "CASH_DEPOSIT_IDEMPOTENT_REPLAY"]) {
    assert.deepEqual(resultOf(action), ["SUCCESS"], action);
  }
  for (const action of ["CASH_DEPOSIT_REJECTED", "CASH_DEPOSIT_IDEMPOTENCY_CONFLICT", "AUTHENTICATION_FAILED", "ACCESS_DENIED"]) {
    assert.deepEqual(resultOf(action), ["FAILURE"], action);
  }
});

test("required security and financial events are recorded, and denied access is audited", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  await generateAuditActivity(base, customerToken, staffToken);
  const logs = (await auditQuery(base, staffToken)).body.auditLogs;
  const actions = new Set(logs.map(log => log.action));
  for (const required of ["AUTHENTICATION_SUCCESS_PASSWORD", "AUTHENTICATION_FAILED", "OTP_VERIFIED", "CASH_DEPOSIT", "CASH_WITHDRAWAL",
    "FUND_TRANSFER", "LOAN_APPLICATION_SUBMITTED", "LOAN_APPLICATION_DECIDED", "ACCOUNT_LIFECYCLE_CHANGED", "ACCESS_DENIED"]) {
    assert.ok(actions.has(required), required + " must be recorded");
  }
  const denied = logs.find(log => log.action === "ACCESS_DENIED");
  assert.equal(denied.userId, "usr-customer-001");
  assert.equal(denied.metadata.path, "/api/admin/audit");
  assert.equal(denied.metadata.role, "CUSTOMER");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("WrongPass-Not-Real-1"), false);
  assert.equal(serialized.includes("Password@123"), false);
});

test("viewing the audit trail is itself audited and customers cannot read it", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  assert.equal((await auditQuery(base, customerToken)).status, 403);
  assert.equal((await fetch(base + "/api/admin/audit")).status, 401);

  assert.equal((await auditQuery(base, staffToken, "?result=FAILURE")).status, 200);
  const second = (await auditQuery(base, staffToken)).body.auditLogs;
  const viewed = second.find(log => log.action === "AUDIT_LOG_VIEWED");
  assert.ok(viewed);
  assert.equal(viewed.userId, "usr-staff-001");
  assert.equal(viewed.metadata.filters.result, "FAILURE");
});

test("audit trail can be filtered by result, action, user and date range and is paged newest first", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  await generateAuditActivity(base, customerToken, staffToken);

  const failures = (await auditQuery(base, staffToken, "?result=FAILURE")).body;
  assert.ok(failures.auditLogs.length > 0);
  assert.ok(failures.auditLogs.every(log => log.result === "FAILURE"));

  const deposits = (await auditQuery(base, staffToken, "?action=CASH_DEPOSIT")).body;
  assert.equal(deposits.total, 1);
  assert.equal(deposits.auditLogs[0].action, "CASH_DEPOSIT");

  const byUser = (await auditQuery(base, staffToken, "?userId=usr-customer-001&action=FUND_TRANSFER")).body;
  assert.equal(byUser.total, 1);
  assert.equal((await auditQuery(base, staffToken, "?userId=usr-staff-001&action=FUND_TRANSFER")).body.total, 0);

  const all = (await auditQuery(base, staffToken)).body;
  assert.equal(all.total, all.auditLogs.length);
  for (let i = 1; i < all.auditLogs.length; i++) {
    assert.ok(all.auditLogs[i - 1].timestamp >= all.auditLogs[i].timestamp, "newest first");
  }

  const stamp = deposits.auditLogs[0].timestamp;
  assert.equal((await auditQuery(base, staffToken, "?action=CASH_DEPOSIT&from=" + stamp + "&to=" + stamp)).body.total, 1, "inclusive range");
  assert.equal((await auditQuery(base, staffToken, "?action=CASH_DEPOSIT&from=" + new Date(Date.parse(stamp) + 1).toISOString())).body.total, 0);
  assert.equal((await auditQuery(base, staffToken, "?action=CASH_DEPOSIT&to=" + new Date(Date.parse(stamp) - 1).toISOString())).body.total, 0);

  // Page through failures only: reading the trail adds its own AUDIT_LOG_VIEWED (a SUCCESS) entry each time,
  // so an unfiltered listing shifts between calls.
  const failureList = (await auditQuery(base, staffToken, "?result=FAILURE")).body;
  assert.ok(failureList.total >= 3);
  const page = (await auditQuery(base, staffToken, "?result=FAILURE&limit=2&offset=1")).body;
  assert.equal(page.auditLogs.length, 2);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 1);
  assert.equal(page.total, failureList.total);
  assert.equal(page.auditLogs[0].id, failureList.auditLogs[1].id);
  assert.equal(page.auditLogs[1].id, failureList.auditLogs[2].id);
  assert.equal((await auditQuery(base, staffToken, "?result=FAILURE&offset=100000")).body.auditLogs.length, 0);
});

test("invalid audit filters are rejected with 400", async t => {
  const { base } = await start(t);
  const staffToken = await loginAs(base, "staff@bms.local");
  const invalid = [
    "?result=maybe", "?result=success", "?action=lowercase", "?action=BAD-ACTION", "?limit=0", "?limit=1001", "?limit=abc",
    "?offset=-1", "?from=bad-date", "?from=2026-10-20&to=2026-10-10", "?userId=a&userId=b", "?userId=has%20space"
  ];
  for (const query of invalid) {
    const response = await auditQuery(base, staffToken, query);
    assert.equal(response.status, 400, query + " should be rejected");
    assert.equal(response.body.auditLogs, undefined);
  }
});

// ---- BMS-NF-004 / issue #43: audit log retention and verification ----

const auditHooks = require("../backend/server");
const DAY_MS = 86400000;
const daysAgo = days => new Date(Date.now() - days * DAY_MS).toISOString();

async function withRetentionEnv(t, value) {
  const previous = process.env.BMS_AUDIT_RETENTION_DAYS;
  if (value === undefined) delete process.env.BMS_AUDIT_RETENTION_DAYS;
  else process.env.BMS_AUDIT_RETENTION_DAYS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.BMS_AUDIT_RETENTION_DAYS;
    else process.env.BMS_AUDIT_RETENTION_DAYS = previous;
  });
}

async function retentionStatus(base, token) {
  const response = await get(base, "/api/admin/audit/retention", token);
  return { status: response.status, body: await response.json() };
}

async function purgeAudit(base, token, body) {
  const response = await fetch(base + "/api/admin/audit/retention/purge", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("audit records are hash-chained and the retention check verifies the retained chain", async t => {
  await withRetentionEnv(t, undefined);
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");
  await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 100 }, customerToken, { "Idempotency-Key": "test-retention-chain-001" });

  const logs = auditHooks.getStore().auditLogs;
  assert.equal(logs[0].prevHash, "GENESIS");
  logs.forEach((log, index) => {
    assert.match(log.hash, /^[0-9a-f]{64}$/);
    if (index > 0) assert.equal(log.prevHash, logs[index - 1].hash, "each record links to the previous one");
  });

  const { status, body } = await retentionStatus(base, staffToken);
  assert.equal(status, 200);
  assert.equal(body.retentionDays, 2555);
  assert.equal(body.integrity.verified, true);
  assert.equal(body.integrity.checked, body.totalRecords);
  assert.equal(body.integrity.brokenRecordId, null);
  assert.equal(body.expiredRecords, 0);
  assert.ok(Date.parse(body.oldestRecordAt) <= Date.parse(body.newestRecordAt));

  // Hashes are visible in the retrieved records so an auditor can check them independently.
  const listing = (await auditQuery(base, staffToken, "?action=CASH_DEPOSIT")).body.auditLogs[0];
  assert.match(listing.hash, /^[0-9a-f]{64}$/);
  assert.match(listing.prevHash, /^[0-9a-f]{64}$/);

  // The check itself is audited (one entry so far) and the extended chain still verifies.
  assert.equal((await auditQuery(base, staffToken, "?action=AUDIT_INTEGRITY_CHECKED")).body.total, 1);
  const again = (await retentionStatus(base, staffToken)).body;
  assert.equal(again.integrity.verified, true);
  assert.equal((await auditQuery(base, staffToken, "?action=AUDIT_INTEGRITY_CHECKED")).body.total, 2);
});

test("tampering with the audit log is detected and reported", async t => {
  await withRetentionEnv(t, undefined);
  const mutations = [
    { name: "modified details", reason: "RECORD_MODIFIED", apply: logs => { const log = logs.find(item => item.action === "CASH_DEPOSIT"); log.metadata.amount = 1; return log.id; } },
    { name: "modified timestamp", reason: "RECORD_MODIFIED", apply: logs => { logs[2].timestamp = daysAgo(400); return logs[2].id; } },
    { name: "deleted record", reason: "CHAIN_LINK_MISMATCH", apply: logs => { const [, , removed, next] = logs; logs.splice(2, 1); return next.id; } },
    { name: "reordered records", reason: "CHAIN_LINK_MISMATCH", apply: logs => { const second = logs[2]; logs[2] = logs[3]; logs[3] = second; return logs[2].id; } }
  ];
  for (const mutation of mutations) {
    const { base } = await start(t);
    const customerToken = await loginAs(base);
    const staffToken = await loginAs(base, "staff@bms.local");
    await post(base, "/api/transactions/deposit", { accountId: "acc-1001", amount: 100 }, customerToken, { "Idempotency-Key": "test-retention-tamper-001" });
    assert.ok(auditHooks.getStore().auditLogs.length >= 5);

    const brokenId = mutation.apply(auditHooks.getStore().auditLogs);
    const { status, body } = await retentionStatus(base, staffToken);
    assert.equal(status, 200);
    assert.equal(body.integrity.verified, false, mutation.name + " must be detected");
    assert.equal(body.integrity.reason, mutation.reason, mutation.name);
    assert.equal(body.integrity.brokenRecordId, brokenId, mutation.name);

    const failed = (await auditQuery(base, staffToken, "?action=AUDIT_INTEGRITY_CHECK_FAILED")).body;
    assert.equal(failed.total, 1);
    assert.equal(failed.auditLogs[0].result, "FAILURE");
  }
});

test("retention period comes from configuration and falls back to the default when invalid", async t => {
  const { base } = await start(t);
  const staffToken = await loginAs(base, "staff@bms.local");
  await withRetentionEnv(t, "30");
  assert.equal((await retentionStatus(base, staffToken)).body.retentionDays, 30);
  for (const invalid of ["abc", "0", "-5", "1.5", ""]) {
    process.env.BMS_AUDIT_RETENTION_DAYS = invalid;
    assert.equal((await retentionStatus(base, staffToken)).body.retentionDays, 2555, "'" + invalid + "' must fall back");
  }
});

test("purge removes only records older than the retention period and the chain still verifies", async t => {
  await withRetentionEnv(t, "30");
  const { base } = await start(t);
  auditHooks.audit("TEST_OLD_EVENT_A", "usr-test", { n: 1 }, daysAgo(45));
  auditHooks.audit("TEST_OLD_EVENT_B", "usr-test", { n: 2 }, daysAgo(31));
  auditHooks.audit("TEST_RECENT_EVENT_C", "usr-test", { n: 3 }, daysAgo(29));
  auditHooks.audit("TEST_RECENT_EVENT_D", "usr-test", { n: 4 }, daysAgo(1));
  const customerToken = await loginAs(base);
  const staffToken = await loginAs(base, "staff@bms.local");

  const before = (await retentionStatus(base, staffToken)).body;
  assert.equal(before.expiredRecords, 2);
  assert.equal(before.integrity.verified, true);

  assert.equal((await purgeAudit(base, customerToken, { confirm: true })).status, 403);
  assert.equal((await purgeAudit(base, staffToken, {})).status, 400);
  assert.equal((await purgeAudit(base, staffToken, { confirm: "yes" })).status, 400);
  assert.equal((await retentionStatus(base, staffToken)).body.expiredRecords, 2, "nothing is removed without confirmation");

  const purge = await purgeAudit(base, staffToken, { confirm: true });
  assert.equal(purge.status, 200);
  assert.equal(purge.body.removed, 2);
  assert.equal(purge.body.retentionDays, 30);

  const remaining = (await auditQuery(base, staffToken, "?userId=usr-test")).body.auditLogs.map(log => log.action).sort();
  assert.deepEqual(remaining, ["TEST_RECENT_EVENT_C", "TEST_RECENT_EVENT_D"], "records inside the period are kept");

  const after = (await retentionStatus(base, staffToken)).body;
  assert.equal(after.expiredRecords, 0);
  assert.equal(after.integrity.verified, true, "the retained chain still verifies after a purge");

  const purged = (await auditQuery(base, staffToken, "?action=AUDIT_RETENTION_PURGED")).body.auditLogs[0];
  assert.equal(purged.userId, "usr-staff-001");
  assert.equal(purged.result, "SUCCESS");
  assert.equal(purged.metadata.removed, 2);
  assert.equal(purged.metadata.retentionDays, 30);

  const second = await purgeAudit(base, staffToken, { confirm: true });
  assert.equal(second.body.removed, 0, "a second purge has nothing left to remove");
});

test("nothing is purged while records are inside the default retention period", async t => {
  await withRetentionEnv(t, undefined);
  const { base } = await start(t);
  auditHooks.audit("TEST_OLD_EVENT_A", "usr-test", {}, daysAgo(400));
  const staffToken = await loginAs(base, "staff@bms.local");
  const purge = await purgeAudit(base, staffToken, { confirm: true });
  assert.equal(purge.status, 200);
  assert.equal(purge.body.removed, 0);
  assert.equal((await auditQuery(base, staffToken, "?action=TEST_OLD_EVENT_A")).body.total, 1);
});

test("retention endpoints require staff access", async t => {
  const { base } = await start(t);
  const customerToken = await loginAs(base);
  assert.equal((await retentionStatus(base, customerToken)).status, 403);
  assert.equal((await fetch(base + "/api/admin/audit/retention")).status, 401);
  const anonymousPurge = await fetch(base + "/api/admin/audit/retention/purge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true })
  });
  assert.equal(anonymousPurge.status, 401);
});

test("records written before hashing existed are reported as legacy and do not break verification or purge", async t => {
  await withRetentionEnv(t, "30");
  const { base } = await start(t);
  const legacy = (idValue, at) => ({ id: idValue, action: "OLD_EVENT", userId: null, timestamp: at, metadata: {} });
  auditHooks.getStore().auditLogs.push(legacy("aud-legacy-1", daysAgo(60)), legacy("aud-legacy-2", daysAgo(3)));
  const staffToken = await loginAs(base, "staff@bms.local");

  const before = (await retentionStatus(base, staffToken)).body;
  assert.equal(before.integrity.verified, true);
  assert.equal(before.integrity.legacyRecords, 2);
  assert.equal(before.integrity.checked, before.totalRecords - 2);
  assert.equal(before.expiredRecords, 1);

  const purge = await purgeAudit(base, staffToken, { confirm: true });
  assert.equal(purge.body.removed, 1, "only the legacy record past retention is removed");
  const after = (await retentionStatus(base, staffToken)).body;
  assert.equal(after.integrity.verified, true);
  assert.equal(after.integrity.legacyRecords, 1);
});

// ---- BMS-NF-005 / issue #44: usability and accessibility (static checks of the shipped front end) ----

const fs = require("node:fs");
const path = require("node:path");
const frontendFile = name => fs.readFileSync(path.join(__dirname, "..", "frontend", name), "utf8");

function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("page basics: language, zoomable viewport, skip link, focusable main landmark, no stale text", () => {
  const html = frontendFile("index.html");
  assert.match(html, /<html lang="en">/);
  const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)[1];
  assert.equal(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(viewport), false, "zoom must not be disabled");
  assert.match(html, /<body>\s*<a class="skip-link" href="#main">/, "skip link must be the first focusable element");
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /<span aria-hidden="true">🏦<\/span>/, "decorative emoji must be hidden from screen readers");
  assert.equal(/Sprint 1/.test(html), false);
});

test("every form control has a programmatic label and login fields declare their purpose", () => {
  const html = frontendFile("index.html");
  const labels = [...html.matchAll(/<label\b[\s\S]*?<\/label>/g)].map(match => [match.index, match.index + match[0].length]);
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)];
  assert.ok(controls.length > 15);
  for (const control of controls) {
    const insideLabel = labels.some(([start, end]) => control.index > start && control.index < end);
    const named = /aria-label(ledby)?=/.test(control[0]);
    assert.ok(insideLabel || named, "unlabelled control: " + control[0].slice(0, 70));
  }
  assert.match(html, /id="email"[^>]*autocomplete="username"/);
  assert.match(html, /id="password"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="otp"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /id="profilePhone"[^>]*type="tel"[^>]*autocomplete="tel"/);
  assert.match(html, /id="loanPurpose"[^>]*aria-describedby="loanPurposeHint"/);
  assert.match(html, /id="loanPurposeHint"/);
});

test("messages are announced to assistive technology and errors are visible long enough to read", () => {
  const html = frontendFile("index.html");
  const js = frontendFile("app.js");
  assert.match(html, /id="authMessage"[^>]*role="alert"/);
  assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="errorToast"[^>]*role="alert"/);
  assert.match(html, /id="loansMessage"[^>]*aria-live="polite"/);
  assert.equal(/\btoast\((e|err|error)\.message\)/.test(js), false, "errors must use toastError, not the polite success toast");
  assert.ok(Number(js.match(/ERROR_TOAST_MS = (\d+)/)[1]) >= 6000, "error messages must stay visible for at least 6 seconds");
});

test("tables have captions and column headers, and scrollable regions are keyboard reachable and named", () => {
  const html = frontendFile("index.html");
  const tables = html.match(/<table>/g) || [];
  assert.ok(tables.length >= 3);
  assert.equal((html.match(/<caption class="sr-only">/g) || []).length, tables.length);
  assert.equal(/<th>/.test(html), false, "every th needs a scope");
  assert.ok(/<th scope="col">/.test(html));
  const regions = html.match(/<div class="table-wrap"[^>]*>/g) || [];
  assert.equal(regions.length, tables.length);
  for (const region of regions) assert.match(region, /tabindex="0"[^>]*role="region"[^>]*aria-label="[^"]+"/);
});

test("keyboard focus is visible, form borders meet 3:1 contrast and buttons are individually named", () => {
  const css = frontendFile("styles.css");
  const js = frontendFile("app.js");
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  assert.equal(/outline:\s*(none|0)\s*[;}]/.test(css.replace(/main:focus,h2:focus\{outline:none\}/, "")), false, "focus outlines must not be removed");
  const border = css.match(/input,select,textarea\{[^}]*border:1px solid (#[0-9a-fA-F]{6})/)[1];
  assert.ok(contrastRatio(border, "#ffffff") >= 3, "input border " + border + " needs 3:1 against white");
  assert.match(js, /aria-label="Remove beneficiary \$\{escapeHtml\(b\.name\)\}"/);
});

test("text colours meet WCAG AA contrast on their backgrounds", () => {
  const pairs = [["#172033", "#f4f7fb"], ["#667085", "#ffffff"], ["#667085", "#f4f7fb"], ["#ffffff", "#1769aa"],
    ["#24415f", "#e8eef6"], ["#2f6b3f", "#eaf4ed"], ["#ffffff", "#172033"], ["#ffffff", "#8a1f11"]];
  const css = frontendFile("styles.css");
  for (const [foreground, background] of pairs) {
    assert.ok(css.toLowerCase().includes(foreground) || foreground === "#ffffff", foreground + " is expected to be used in styles.css");
    assert.ok(contrastRatio(foreground, background) >= 4.5, foreground + " on " + background + " must be at least 4.5:1");
  }
});
