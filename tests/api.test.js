const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BMS_PERSISTENCE = "false";
process.env.BMS_DEMO_MODE = "true";

const { createApp } = require("../backend/server");

async function start() {
  const app = createApp();
  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, path, body, token) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
}

test("health endpoint responds", async () => {
  const { server, base } = await start();
  const r = await fetch(base + "/api/health");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "ok");
  server.close();
});

test("customer can authenticate with password and OTP", async () => {
  const { server, base } = await start();
  const login = await post(base, "/api/auth/login", { email:"customer@bms.local", password:"Password@123" });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.requiresOtp, true);
  const verify = await post(base, "/api/auth/verify-otp", { userId:loginBody.userId, otp:"123456" });
  assert.equal(verify.status, 200);
  const authBody = await verify.json();
  assert.ok(authBody.token);
  server.close();
});

test("authenticated customer can deposit, withdraw and transfer", async () => {
  const { server, base } = await start();
  const login = await post(base, "/api/auth/login", { email:"customer@bms.local", password:"Password@123" });
  const lb = await login.json();
  const verify = await post(base, "/api/auth/verify-otp", { userId:lb.userId, otp:"123456" });
  const vb = await verify.json();
  const token = vb.token;

  const deposit = await post(base, "/api/transactions/deposit", { accountId:"acc-1001", amount:250 }, token);
  assert.equal(deposit.status, 201);

  const withdraw = await post(base, "/api/transactions/withdraw", { accountId:"acc-1001", amount:100 }, token);
  assert.equal(withdraw.status, 201);

  const transfer = await post(base, "/api/transactions/transfer", { fromAccountId:"acc-1001", toAccountNumber:"1000002001", amount:500 }, token);
  assert.equal(transfer.status, 201);

  const accounts = await fetch(base + "/api/accounts", { headers:{ authorization:`Bearer ${token}` } });
  const accountBody = await accounts.json();
  assert.equal(accountBody.accounts.find(a=>a.id==="acc-1001").balance, 9650);
  server.close();
});

test("invalid withdrawal is rejected", async () => {
  const { server, base } = await start();
  const login = await post(base, "/api/auth/login", { email:"customer@bms.local", password:"Password@123" });
  const lb = await login.json();
  const verify = await post(base, "/api/auth/verify-otp", { userId:lb.userId, otp:"123456" });
  const vb = await verify.json();
  const result = await post(base, "/api/transactions/withdraw", { accountId:"acc-1001", amount:999999 }, vb.token);
  assert.equal(result.status, 400);
  server.close();
});
