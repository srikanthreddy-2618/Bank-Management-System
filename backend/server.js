const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const PORT = Number(process.env.PORT || 3000);
const PERSISTENCE = process.env.BMS_PERSISTENCE !== "false";
const DATA_FILE = process.env.BMS_DATA_FILE || path.join(__dirname, "data", "db.json");
const DEMO_MODE = process.env.BMS_DEMO_MODE !== "false";
const OTP = process.env.BMS_DEMO_OTP || "123456";
const JWT_SECRET = process.env.BMS_JWT_SECRET || "bms-academic-demo-change-me";

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return prefix + crypto.randomBytes(6).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, record) {
  const candidate = crypto.scryptSync(password, record.salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(record.hash, "hex"));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 4
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return body + "." + signature;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  if (signature !== expected) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function seedStore() {
  const customerPassword = hashPassword("Password@123");
  const staffPassword = hashPassword("Password@123");
  return {
    users: [
      {
        id: "usr-customer-001",
        email: "customer@bms.local",
        name: "Demo Customer",
        role: "CUSTOMER",
        phone: "9876543210",
        failedAttempts: 0,
        lockedUntil: null,
        password: customerPassword,
        kycStatus: "VERIFIED",
        createdAt: now()
      },
      {
        id: "usr-staff-001",
        email: "staff@bms.local",
        name: "Demo Staff",
        role: "STAFF",
        phone: "9123456780",
        failedAttempts: 0,
        lockedUntil: null,
        password: staffPassword,
        kycStatus: "VERIFIED",
        createdAt: now()
      }
    ],
    accounts: [
      {
        id: "acc-1001",
        accountNumber: "1000001001",
        userId: "usr-customer-001",
        type: "SAVINGS",
        status: "ACTIVE",
        balance: 10000,
        openedAt: now()
      },
      {
        id: "acc-1002",
        accountNumber: "1000001002",
        userId: "usr-customer-001",
        type: "CURRENT",
        status: "ACTIVE",
        balance: 5000,
        openedAt: now()
      },
      {
        id: "acc-2001",
        accountNumber: "1000002001",
        userId: "usr-staff-001",
        type: "SAVINGS",
        status: "ACTIVE",
        balance: 25000,
        openedAt: now()
      }
    ],
    beneficiaries: [],
    transactions: [],
    notifications: [
      {
        id: "ntf-001",
        userId: "usr-customer-001",
        title: "Welcome to BMS",
        message: "Your demo banking profile is ready.",
        read: false,
        createdAt: now()
      }
    ],
    auditLogs: [],
    otps: {}
  };
}

function loadStore() {
  if (!PERSISTENCE) return seedStore();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = seedStore();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    const initial = seedStore();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

let store = loadStore();

function saveStore() {
  if (!PERSISTENCE) return;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function audit(action, userId, metadata = {}) {
  store.auditLogs.push({
    id: id("aud-"),
    action,
    userId,
    timestamp: now(),
    metadata: JSON.parse(JSON.stringify(metadata))
  });
  saveStore();
}

function addNotification(userId, title, message) {
  store.notifications.unshift({
    id: id("ntf-"),
    userId,
    title,
    message,
    read: false,
    createdAt: now()
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: user.phone,
    kycStatus: user.kycStatus
  };
}

function publicAccount(account) {
  return { ...account };
}

function authRequired(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: "Authentication required" });
    const user = store.users.find(u => u.id === payload.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid authentication token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient privileges" });
    }
    next();
  };
}

function positiveAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function ownedAccount(user, accountId) {
  const account = store.accounts.find(a => a.id === accountId);
  if (!account) return null;
  if (user.role !== "STAFF" && account.userId !== user.id) return undefined;
  return account;
}

function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "BMS API", timestamp: now() });
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const user = store.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return res.status(423).json({ error: "Account temporarily locked. Try again later." });
    }

    if (!verifyPassword(password, user.password)) {
      user.failedAttempts = (user.failedAttempts || 0) + 1;
      if (user.failedAttempts >= 5) {
        user.failedAttempts = 0;
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      saveStore();
      return res.status(401).json({ error: "Invalid credentials" });
    }

    user.failedAttempts = 0;
    user.lockedUntil = null;
    const otp = DEMO_MODE ? OTP : String(crypto.randomInt(100000, 1000000));
    store.otps[user.id] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };
    saveStore();
    audit("AUTHENTICATION_SUCCESS_PASSWORD", user.id);
    const response = {
      requiresOtp: true,
      userId: user.id,
      destination: user.phone.replace(/(\d{2})\d{6}(\d{2})/, "$1******$2")
    };
    if (DEMO_MODE) response.demoOtp = otp;
    res.json(response);
  });

  app.post("/api/auth/verify-otp", (req, res) => {
    const { userId, otp } = req.body || {};
    const entry = store.otps[userId];
    if (!entry || Date.now() > entry.expiresAt || String(otp) !== String(entry.otp)) {
      return res.status(401).json({ error: "Invalid or expired OTP" });
    }
    delete store.otps[userId];
    const user = store.users.find(u => u.id === userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    saveStore();
    audit("OTP_VERIFIED", user.id);
    res.json({
      token: signToken({ userId: user.id, role: user.role }),
      user: publicUser(user)
    });
  });

  app.post("/api/auth/logout", authRequired, (req, res) => {
    audit("LOGOUT", req.user.id);
    res.json({ message: "Logged out" });
  });

  app.get("/api/me", authRequired, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.put("/api/profile", authRequired, (req, res) => {
    const allowed = ["name", "phone"];
    for (const key of allowed) {
      if (req.body && typeof req.body[key] === "string" && req.body[key].trim()) {
        req.user[key] = req.body[key].trim();
      }
    }
    saveStore();
    audit("PROFILE_UPDATED", req.user.id, { fields: allowed.filter(k => req.body?.[k]) });
    res.json({ user: publicUser(req.user) });
  });

  app.get("/api/accounts", authRequired, (req, res) => {
    const accounts = store.accounts.filter(a => req.user.role === "STAFF" ? true : a.userId === req.user.id);
    res.json({ accounts: accounts.map(publicAccount) });
  });

  app.post("/api/accounts", authRequired, requireRole("STAFF"), (req, res) => {
    const { userId, type = "SAVINGS", initialDeposit = 0 } = req.body || {};
    const customer = store.users.find(u => u.id === userId);
    if (!customer || customer.role !== "CUSTOMER") return res.status(400).json({ error: "Customer not found" });
    const deposit = positiveAmount(initialDeposit) ?? 0;
    const accountNumber = "1000" + String(crypto.randomInt(100000, 1000000));
    const account = {
      id: id("acc-"),
      accountNumber,
      userId,
      type,
      status: "ACTIVE",
      balance: deposit,
      openedAt: now()
    };
    store.accounts.push(account);
    addNotification(userId, "Account created", "A new bank account has been created for you.");
    saveStore();
    audit("ACCOUNT_CREATED", req.user.id, { accountId: account.id, customerId: userId });
    res.status(201).json({ account: publicAccount(account) });
  });

  app.patch("/api/accounts/:id/lifecycle", authRequired, requireRole("STAFF"), (req, res) => {
    const account = store.accounts.find(a => a.id === req.params.id);
    const status = req.body?.status;
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (!["ACTIVE", "FROZEN", "CLOSED"].includes(status)) return res.status(400).json({ error: "Invalid lifecycle status" });
    if (account.status === "CLOSED" && status !== "CLOSED") return res.status(400).json({ error: "Closed accounts cannot be reopened" });
    account.status = status;
    saveStore();
    audit("ACCOUNT_LIFECYCLE_CHANGED", req.user.id, { accountId: account.id, status });
    res.json({ account: publicAccount(account) });
  });

  app.get("/api/transactions", authRequired, (req, res) => {
    const accountId = req.query.accountId;
    const accounts = store.accounts.filter(a => req.user.role === "STAFF" ? true : a.userId === req.user.id);
    const allowed = accountId ? accounts.filter(a => a.id === accountId).map(a => a.id) : accounts.map(a => a.id);
    if (accountId && allowed.length === 0) return res.status(403).json({ error: "Unauthorized account" });
    const transactions = store.transactions.filter(t => allowed.includes(t.accountId) || allowed.includes(t.counterpartyAccountId));
    res.json({ transactions: transactions.sort((a,b) => b.createdAt.localeCompare(a.createdAt)) });
  });

  app.post("/api/transactions/deposit", authRequired, (req, res) => {
    const account = ownedAccount(req.user, req.body?.accountId);
    if (account === undefined) return res.status(403).json({ error: "Unauthorized account" });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (account.status !== "ACTIVE") return res.status(400).json({ error: "Account is not active" });
    const amount = positiveAmount(req.body?.amount);
    if (!amount) return res.status(400).json({ error: "Amount must be positive" });
    account.balance += amount;
    const transaction = {
      id: id("txn-"),
      accountId: account.id,
      type: "DEPOSIT",
      amount,
      balanceAfter: account.balance,
      description: req.body.description || "Cash deposit",
      createdAt: now(),
      status: "SUCCESS"
    };
    store.transactions.push(transaction);
    addNotification(account.userId, "Deposit successful", `₹${amount.toFixed(2)} was deposited into account ${account.accountNumber}.`);
    saveStore();
    audit("CASH_DEPOSIT", req.user.id, { accountId: account.id, amount });
    res.status(201).json({ transaction, account: publicAccount(account) });
  });

  app.post("/api/transactions/withdraw", authRequired, (req, res) => {
    const account = ownedAccount(req.user, req.body?.accountId);
    if (account === undefined) return res.status(403).json({ error: "Unauthorized account" });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (account.status !== "ACTIVE") return res.status(400).json({ error: "Account is not active" });
    const amount = positiveAmount(req.body?.amount);
    if (!amount) return res.status(400).json({ error: "Amount must be positive" });
    if (account.balance < amount) return res.status(400).json({ error: "Insufficient balance" });
    account.balance -= amount;
    const transaction = {
      id: id("txn-"),
      accountId: account.id,
      type: "WITHDRAWAL",
      amount,
      balanceAfter: account.balance,
      description: req.body.description || "Cash withdrawal",
      createdAt: now(),
      status: "SUCCESS"
    };
    store.transactions.push(transaction);
    addNotification(account.userId, "Withdrawal successful", `₹${amount.toFixed(2)} was withdrawn from account ${account.accountNumber}.`);
    saveStore();
    audit("CASH_WITHDRAWAL", req.user.id, { accountId: account.id, amount });
    res.status(201).json({ transaction, account: publicAccount(account) });
  });

  app.post("/api/transactions/transfer", authRequired, (req, res) => {
    const source = ownedAccount(req.user, req.body?.fromAccountId);
    if (source === undefined) return res.status(403).json({ error: "Unauthorized source account" });
    if (!source) return res.status(404).json({ error: "Source account not found" });
    const destination = store.accounts.find(a => a.accountNumber === String(req.body?.toAccountNumber || ""));
    if (!destination) return res.status(404).json({ error: "Destination account not found" });
    if (source.id === destination.id) return res.status(400).json({ error: "Source and destination accounts must differ" });
    if (source.status !== "ACTIVE" || destination.status !== "ACTIVE") return res.status(400).json({ error: "Both accounts must be active" });
    const amount = positiveAmount(req.body?.amount);
    if (!amount) return res.status(400).json({ error: "Amount must be positive" });
    if (source.balance < amount) return res.status(400).json({ error: "Insufficient balance" });

    source.balance -= amount;
    destination.balance += amount;
    const timestamp = now();
    const outbound = {
      id: id("txn-"),
      accountId: source.id,
      counterpartyAccountId: destination.id,
      type: "TRANSFER_OUT",
      amount,
      balanceAfter: source.balance,
      description: req.body.description || "Fund transfer",
      createdAt: timestamp,
      status: "SUCCESS"
    };
    const inbound = {
      id: id("txn-"),
      accountId: destination.id,
      counterpartyAccountId: source.id,
      type: "TRANSFER_IN",
      amount,
      balanceAfter: destination.balance,
      description: req.body.description || "Fund transfer received",
      createdAt: timestamp,
      status: "SUCCESS"
    };
    store.transactions.push(outbound, inbound);
    addNotification(source.userId, "Transfer successful", `₹${amount.toFixed(2)} was transferred to ${destination.accountNumber}.`);
    addNotification(destination.userId, "Transfer received", `₹${amount.toFixed(2)} was received from account ${source.accountNumber}.`);
    saveStore();
    audit("FUND_TRANSFER", req.user.id, { sourceAccountId: source.id, destinationAccountId: destination.id, amount });
    res.status(201).json({ transaction: outbound, account: publicAccount(source) });
  });

  app.get("/api/beneficiaries", authRequired, (req, res) => {
    res.json({ beneficiaries: store.beneficiaries.filter(b => b.userId === req.user.id) });
  });

  app.post("/api/beneficiaries", authRequired, (req, res) => {
    const accountNumber = String(req.body?.accountNumber || "");
    const destination = store.accounts.find(a => a.accountNumber === accountNumber);
    if (!destination) return res.status(404).json({ error: "Destination account not found" });
    if (destination.userId === req.user.id) return res.status(400).json({ error: "Own account cannot be a beneficiary" });
    const beneficiary = {
      id: id("ben-"),
      userId: req.user.id,
      name: req.body?.name || "Beneficiary",
      accountNumber,
      createdAt: now()
    };
    store.beneficiaries.push(beneficiary);
    saveStore();
    audit("BENEFICIARY_ADDED", req.user.id, { beneficiaryId: beneficiary.id });
    res.status(201).json({ beneficiary });
  });

  app.delete("/api/beneficiaries/:id", authRequired, (req, res) => {
    const index = store.beneficiaries.findIndex(b => b.id === req.params.id && b.userId === req.user.id);
    if (index < 0) return res.status(404).json({ error: "Beneficiary not found" });
    const [removed] = store.beneficiaries.splice(index, 1);
    saveStore();
    audit("BENEFICIARY_REMOVED", req.user.id, { beneficiaryId: removed.id });
    res.json({ message: "Beneficiary removed" });
  });

  app.get("/api/notifications", authRequired, (req, res) => {
    res.json({ notifications: store.notifications.filter(n => n.userId === req.user.id) });
  });

  app.get("/api/admin/audit", authRequired, requireRole("STAFF"), (_req, res) => {
    res.json({
      auditLogs: store.auditLogs.slice().sort((a,b) => b.timestamp.localeCompare(a.timestamp)).map(log => ({
        id: log.id, action: log.action, userId: log.userId, timestamp: log.timestamp, metadata: log.metadata
      }))
    });
  });

  app.use(express.static(path.join(__dirname, "..", "frontend")));

  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function startServer(port = PORT) {
  const app = createApp();
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`BMS server running on port ${server.address().port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer, seedStore, hashPassword, verifyPassword };
