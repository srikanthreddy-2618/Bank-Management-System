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
