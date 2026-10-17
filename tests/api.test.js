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
  }, token);
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
  }, token);
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

test("invalid deposits are rejected without changing balance or creating transactions", async t => {
  const { base } = await start(t);
  const token = await loginAs(base);

  const invalidCases = [
    { name: "zero amount", body: { accountId: "acc-1001", amount: 0 } },
    { name: "negative amount", body: { accountId: "acc-1001", amount: -10 } },
    { name: "missing amount", body: { accountId: "acc-1001" } },
    { name: "missing account", body: { amount: 100 } },
    { name: "unknown account", body: { accountId: "missing-account", amount: 100 } }
  ];

  for (const item of invalidCases) {
    const response = await post(
      base, "/api/transactions/deposit", item.body, token
    );
    assert.ok(
      [400, 403, 404].includes(response.status),
      `${item.name}: unexpected status ${response.status}`
    );
    assert.equal(
      await accountBalance(base, token),
      10000,
      `${item.name} must not change the balance`
    );
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
  }, customerToken);

  assert.equal(response.status, 403);
  assert.equal(await accountBalance(base, customerToken), 10000);
  assert.equal(await accountBalance(base, staffToken, "acc-2001"), 25000);

  const staffTransactions = await accountTransactions(base, staffToken, "acc-2001");
  assert.equal(
    staffTransactions.filter(item => item.type === "DEPOSIT").length,
    0
  );
});
