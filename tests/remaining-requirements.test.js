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
  return { base: "http://127.0.0.1:" + server.address().port };
}

async function request(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: "Bearer " + options.token } : {}),
      ...(options.headers || {})
    }
  });
}

async function login(base, email) {
  const password = "Password@123";
  const loginResponse = await request(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  const otpResponse = await request(base, "/api/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ userId: loginBody.userId, otp: "123456" })
  });
  assert.equal(otpResponse.status, 200);
  return (await otpResponse.json()).token;
}

test("account statement returns scoped balances, credits, debits and transactions", async t => {
  const { base } = await start(t);
  const token = await login(base, "customer@bms.local");

  const deposit = await request(base, "/api/transactions/deposit", {
    method: "POST",
    token,
    headers: { "Idempotency-Key": "statement-deposit-001" },
    body: JSON.stringify({ accountId: "acc-1001", amount: 250 })
  });
  assert.equal(deposit.status, 201);

  const withdrawal = await request(base, "/api/transactions/withdraw", {
    method: "POST",
    token,
    headers: { "Idempotency-Key": "statement-withdrawal-001" },
    body: JSON.stringify({ accountId: "acc-1001", amount: 100 })
  });
  assert.equal(withdrawal.status, 201);

  const statementResponse = await request(base, "/api/accounts/acc-1001/statement", { token });
  assert.equal(statementResponse.status, 200);
  const { statement } = await statementResponse.json();

  assert.equal(statement.openingBalance, 10000);
  assert.equal(statement.totalCredits, 250);
  assert.equal(statement.totalDebits, 100);
  assert.equal(statement.closingBalance, 10150);
  assert.equal(statement.transactions.length, 2);
  assert.equal(statement.transactions[0].type, "WITHDRAWAL");

  const unauthorized = await request(base, "/api/accounts/acc-2001/statement", { token });
  assert.equal(unauthorized.status, 403);
});

test("staff can create users, list users, change roles and create customer accounts", async t => {
  const { base } = await start(t);
  const staffToken = await login(base, "staff@bms.local");

  const list = await request(base, "/api/admin/users", { token: staffToken });
  assert.equal(list.status, 200);
  const initialUsers = (await list.json()).users;
  assert.ok(initialUsers.some(user => user.role === "STAFF"));

  const created = await request(base, "/api/admin/users", {
    method: "POST",
    token: staffToken,
    body: JSON.stringify({
      name: "QA Test Customer",
      email: "qa.customer@example.com",
      phone: "9999999999",
      password: "TempPass123!",
      role: "CUSTOMER"
    })
  });
  assert.equal(created.status, 201);
  const createdUser = (await created.json()).user;
  assert.equal(createdUser.role, "CUSTOMER");

  const roleChange = await request(base, "/api/admin/users/" + createdUser.id + "/role", {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({ role: "STAFF" })
  });
  assert.equal(roleChange.status, 200);
  assert.equal((await roleChange.json()).user.role, "STAFF");

  const account = await request(base, "/api/accounts", {
    method: "POST",
    token: staffToken,
    body: JSON.stringify({
      userId: createdUser.id,
      type: "SAVINGS",
      initialDeposit: 1000
    })
  });
  assert.equal(account.status, 201);
  assert.equal((await account.json()).account.balance, 1000);
});

test("customers cannot access staff user administration", async t => {
  const { base } = await start(t);
  const customerToken = await login(base, "customer@bms.local");

  const users = await request(base, "/api/admin/users", { token: customerToken });
  assert.equal(users.status, 403);

  const createUser = await request(base, "/api/admin/users", {
    method: "POST",
    token: customerToken,
    body: JSON.stringify({
      name: "Denied User",
      email: "denied@example.com",
      phone: "9999999999",
      password: "TempPass123!",
      role: "CUSTOMER"
    })
  });
  assert.equal(createUser.status, 403);
});

test("approved loans expose a complete installment schedule", async t => {
  const { base } = await start(t);
  const customerToken = await login(base, "customer@bms.local");
  const staffToken = await login(base, "staff@bms.local");

  const application = await request(base, "/api/loans", {
    method: "POST",
    token: customerToken,
    body: JSON.stringify({ amount: 12000, purpose: "Education loan", tenureMonths: 12 })
  });
  assert.equal(application.status, 201);
  const loanId = (await application.json()).loan.id;

  const decision = await request(base, "/api/loans/" + loanId + "/decision", {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({
      decision: "APPROVED",
      annualRatePercent: 12,
      disbursementAccountId: "acc-1001"
    })
  });
  assert.equal(decision.status, 200);
  const loan = (await decision.json()).loan;

  assert.equal(loan.repaymentSchedule.length, 12);
  assert.equal(loan.repaymentSchedule[0].installmentNumber, 1);
  assert.equal(loan.repaymentSchedule[11].installmentNumber, 12);
  assert.equal(loan.repaymentSchedule.at(-1).outstandingAfter, 0);
});
