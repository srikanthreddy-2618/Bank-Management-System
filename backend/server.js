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
const JWT_SECRET = process.env.BMS_JWT_SECRET || crypto.randomBytes(32).toString("hex");

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
    loans: [],
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
    otps: {},
    idempotencyKeys: {}
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
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!loaded || typeof loaded !== "object") throw new Error("Invalid BMS data store");
    // Backward-compatible migration for older local demo files.
    if (!loaded.idempotencyKeys || typeof loaded.idempotencyKeys !== "object") loaded.idempotencyKeys = {};
    if (!loaded.otps || typeof loaded.otps !== "object") loaded.otps = {};
    if (!Array.isArray(loaded.loans)) loaded.loans = [];
    return loaded;
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
  // Atomic rename reduces the chance of leaving a partially written JSON store.
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function sanitizeAuditMetadata(value) {
  const forbiddenKey = /(password|otp|token|secret|authorization|credential|cookie)/i;
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (value && typeof value === "object") {
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
      if (!forbiddenKey.test(key)) safe[key] = sanitizeAuditMetadata(item);
    }
    return safe;
  }
  if (typeof value === "string") {
    return value.replace(/(password|otp|token|secret|authorization|credential)\s*[:=]\s*[^\s,;]+/ig, "$1=[REDACTED]");
  }
  return value;
}

function audit(action, userId, metadata = {}) {
  store.auditLogs.push({
    id: id("aud-"),
    action,
    userId: userId || null,
    timestamp: now(),
    metadata: sanitizeAuditMetadata(metadata)
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

function createApp({ freshStore = false } = {}) {
  // Tests request a fresh in-memory store for isolation; production keeps its loaded store.
  if (freshStore) store = loadStore();
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
    if (!user) {
      audit("AUTHENTICATION_FAILED", null, { reason: "UNKNOWN_USER" });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      audit("AUTHENTICATION_BLOCKED", user.id, { reason: "ACCOUNT_LOCKED" });
      return res.status(423).json({ error: "Account temporarily locked. Try again later." });
    }

    if (!verifyPassword(password, user.password)) {
      user.failedAttempts = (user.failedAttempts || 0) + 1;
      if (user.failedAttempts >= 5) {
        user.failedAttempts = 0;
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      saveStore();
      audit("AUTHENTICATION_FAILED", user.id, { reason: "INVALID_PASSWORD", failedAttempts: user.failedAttempts });
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
      const knownUser = store.users.find(user => user.id === userId);
      const reason = !entry ? "OTP_NOT_FOUND" : Date.now() > entry.expiresAt ? "OTP_EXPIRED" : "INVALID_OTP";
      audit("OTP_VERIFICATION_FAILED", knownUser?.id || null, { reason });
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

  app.post("/api/loans", authRequired, (req, res) => {
    if (req.user.role !== "CUSTOMER") return res.status(403).json({ error: "Only customers can apply for loans" });
    const requestedAmount = positiveAmount(req.body?.amount);
    const purpose = typeof req.body?.purpose === "string" ? req.body.purpose.trim() : "";
    const tenureMonths = Number(req.body?.tenureMonths);
    if (!requestedAmount) return res.status(400).json({ error: "Loan amount must be positive" });
    if (!Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360) {
      return res.status(400).json({ error: "Tenure must be between 1 and 360 months" });
    }
    if (purpose.length < 5 || purpose.length > 240) {
      return res.status(400).json({ error: "Purpose must be between 5 and 240 characters" });
    }
    const loan = {
      id: id("loan-"),
      userId: req.user.id,
      amount: requestedAmount,
      purpose,
      tenureMonths,
      status: "PENDING",
      repaymentAmount: null,
      outstandingBalance: null,
      submittedAt: now(),
      decisionAt: null
    };
    store.loans.push(loan);
    addNotification(req.user.id, "Loan application submitted", "Your application for ₹" + requestedAmount.toFixed(2) + " is pending review.");
    saveStore();
    audit("LOAN_APPLICATION_SUBMITTED", req.user.id, { loanId: loan.id, amount: requestedAmount, tenureMonths });
    return res.status(201).json({ loan });
  });

  app.get("/api/loans", authRequired, (req, res) => {
    const loans = (store.loans || []).filter(loan => req.user.role === "STAFF" || loan.userId === req.user.id);
    return res.json({ loans: loans.slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) });
  });

  app.get("/api/loans/:id", authRequired, (req, res) => {
    const loan = (store.loans || []).find(item => item.id === req.params.id);
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (req.user.role !== "STAFF" && loan.userId !== req.user.id) return res.status(403).json({ error: "Unauthorized loan" });
    return res.json({ loan });
  });

  app.patch("/api/loans/:id/decision", authRequired, requireRole("STAFF"), (req, res) => {
    const loan = (store.loans || []).find(item => item.id === req.params.id);
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (loan.status !== "PENDING") return res.status(409).json({ error: "Only pending applications can be decided" });
    const decision = req.body?.decision;
    if (decision !== "APPROVED" && decision !== "REJECTED") return res.status(400).json({ error: "Decision must be APPROVED or REJECTED" });

    let repaymentAmount = null;
    let outstandingBalance = null;
    let disbursementAccount = null;
    let disbursementTransaction = null;
    let annualRatePercent = null;

    if (decision === "APPROVED") {
      annualRatePercent = Number(req.body?.annualRatePercent ?? 0);
      if (!Number.isFinite(annualRatePercent) || annualRatePercent < 0 || annualRatePercent > 100) {
        return res.status(400).json({ error: "Annual rate must be between 0 and 100 percent" });
      }
      const disbursementAccountId = String(req.body?.disbursementAccountId || "");
      disbursementAccount = store.accounts.find(account => account.id === disbursementAccountId);
      if (!disbursementAccount || disbursementAccount.userId !== loan.userId) {
        return res.status(400).json({ error: "Select a valid account belonging to the loan applicant for disbursement" });
      }
      if (disbursementAccount.status !== "ACTIVE") {
        return res.status(400).json({ error: "Loan disbursement account must be active" });
      }
      const monthlyRate = annualRatePercent / 1200;
      const payment = monthlyRate === 0
        ? loan.amount / loan.tenureMonths
        : loan.amount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -loan.tenureMonths));
      repaymentAmount = Math.round(payment * 100) / 100;
      // Track the sum of rounded monthly installments (including interest).
      outstandingBalance = Math.round(repaymentAmount * loan.tenureMonths * 100) / 100;
    }

    loan.status = decision;
    loan.annualRatePercent = annualRatePercent;
    loan.repaymentAmount = repaymentAmount;
    loan.outstandingBalance = outstandingBalance;
    loan.decisionAt = now();

    if (decision === "APPROVED") {
      disbursementAccount.balance = Math.round((disbursementAccount.balance + loan.amount) * 100) / 100;
      loan.disbursementAccountId = disbursementAccount.id;
      disbursementTransaction = {
        id: id("txn-"),
        accountId: disbursementAccount.id,
        type: "LOAN_DISBURSEMENT",
        amount: loan.amount,
        balanceAfter: disbursementAccount.balance,
        description: "Loan disbursement " + loan.id,
        loanId: loan.id,
        createdAt: now(),
        status: "SUCCESS"
      };
      store.transactions.push(disbursementTransaction);
    }

    addNotification(loan.userId, "Loan application " + decision.toLowerCase(), decision === "APPROVED"
      ? "Your loan was approved and ₹" + Number(loan.amount).toFixed(2) + " was credited. Monthly repayment is ₹" + repaymentAmount.toFixed(2) + "."
      : "Your loan application was rejected.");
    saveStore();
    audit("LOAN_APPLICATION_DECIDED", req.user.id, {
      loanId: loan.id, decision, repaymentAmount,
      disbursementAccountId: disbursementAccount?.id || null,
      disbursementTransactionId: disbursementTransaction?.id || null
    });
    return res.json({ loan, account: disbursementAccount ? publicAccount(disbursementAccount) : null, transaction: disbursementTransaction });
  });

  app.post("/api/loans/:id/repayments", authRequired, (req, res) => {
    const loan = (store.loans || []).find(item => item.id === req.params.id);
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (loan.userId !== req.user.id || req.user.role !== "CUSTOMER") return res.status(403).json({ error: "Only the loan holder can make a repayment" });
    if (loan.status !== "APPROVED" || loan.outstandingBalance === null) {
      return res.status(400).json({ error: "Only approved loans can be repaid" });
    }
    const account = ownedAccount(req.user, req.body?.accountId);
    if (account === undefined) return res.status(403).json({ error: "Unauthorized repayment account" });
    if (!account) return res.status(404).json({ error: "Repayment account not found" });
    if (account.userId !== loan.userId) return res.status(403).json({ error: "Repayment account must belong to the loan holder" });
    if (account.status !== "ACTIVE") return res.status(400).json({ error: "Repayment account is not active" });
    const amount = positiveAmount(req.body?.amount);
    if (!amount) return res.status(400).json({ error: "Repayment amount must be positive" });
    if (amount > loan.outstandingBalance + 0.0001) return res.status(400).json({ error: "Repayment exceeds outstanding balance" });
    if (account.balance < amount) return res.status(400).json({ error: "Insufficient funds in repayment account" });

    // Update the customer's account and loan ledger in the same in-memory operation.
    account.balance = Math.round((account.balance - amount) * 100) / 100;
    loan.outstandingBalance = Math.max(0, Math.round((loan.outstandingBalance - amount) * 100) / 100);
    loan.lastRepaymentAt = now();
    if (loan.outstandingBalance === 0) loan.status = "PAID";
    const repayment = {
      id: id("repay-"),
      loanId: loan.id,
      accountId: account.id,
      userId: loan.userId,
      amount,
      outstandingAfter: loan.outstandingBalance,
      createdAt: now()
    };
    if (!Array.isArray(loan.repayments)) loan.repayments = [];
    loan.repayments.push(repayment);
    const transaction = {
      id: id("txn-"),
      accountId: account.id,
      type: "LOAN_REPAYMENT",
      amount,
      balanceAfter: account.balance,
      description: "Loan repayment " + loan.id,
      loanId: loan.id,
      repaymentId: repayment.id,
      createdAt: now(),
      status: "SUCCESS"
    };
    store.transactions.push(transaction);
    addNotification(loan.userId, "Loan repayment recorded", "A repayment of ₹" + amount.toFixed(2) + " was recorded.");
    saveStore();
    audit("LOAN_REPAYMENT_RECORDED", req.user.id, { loanId: loan.id, repaymentId: repayment.id, accountId: account.id, amount, outstandingAfter: loan.outstandingBalance });
    return res.status(201).json({ repayment, transaction, account: publicAccount(account), loan });
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
    const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : null;
    const amount = positiveAmount(req.body?.amount);
    const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();

    // Require a client-generated key so a network retry can safely repeat this request.
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      audit("CASH_WITHDRAWAL_REJECTED", req.user.id, { reason: "MISSING_OR_INVALID_IDEMPOTENCY_KEY" });
      return res.status(400).json({ error: "A valid Idempotency-Key header is required for withdrawals" });
    }

    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ accountId, amount }))
      .digest("hex");
    // Scope keys to the authenticated user and withdrawal operation.
    const scopedKey = req.user.id + ":withdraw:" + idempotencyKey;
    const previous = store.idempotencyKeys[scopedKey];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        audit("CASH_WITHDRAWAL_IDEMPOTENCY_CONFLICT", req.user.id, {
          accountId, reason: "KEY_REUSED_WITH_DIFFERENT_REQUEST"
        });
        return res.status(409).json({ error: "Idempotency-Key was already used for a different withdrawal request" });
      }
      audit("CASH_WITHDRAWAL_IDEMPOTENT_REPLAY", req.user.id, {
        accountId, transactionId: previous.response.transaction.id
      });
      return res.status(previous.statusCode || 201).json({ ...previous.response, idempotentReplay: true });
    }

    const reject = (status, error, reason) => {
      const metadata = { reason };
      if (accountId && accountId.length <= 40) metadata.accountId = accountId;
      audit("CASH_WITHDRAWAL_REJECTED", req.user.id, metadata);
      return res.status(status).json({ error });
    };

    const account = ownedAccount(req.user, accountId);
    if (account === undefined) return reject(403, "Unauthorized account", "UNAUTHORIZED_ACCOUNT");
    if (!account) return reject(404, "Account not found", "ACCOUNT_NOT_FOUND");
    if (account.status !== "ACTIVE") return reject(400, "Account is not active", "ACCOUNT_NOT_ACTIVE");
    if (!amount) return reject(400, "Amount must be positive", "INVALID_AMOUNT");
    if (account.balance < amount) return reject(400, "Insufficient balance", "INSUFFICIENT_BALANCE");

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
    addNotification(account.userId, "Withdrawal successful", "₹" + amount.toFixed(2) + " was withdrawn from account " + account.accountNumber + ".");

    const response = { transaction, account: publicAccount(account) };
    // Persist the debit, transaction and idempotency result together in the demo store.
    store.idempotencyKeys[scopedKey] = { fingerprint, statusCode: 201, response, createdAt: now() };
    saveStore();
    audit("CASH_WITHDRAWAL", req.user.id, {
      accountId: account.id, amount, transactionId: transaction.id,
      idempotencyKeyHash: crypto.createHash("sha256").update(idempotencyKey).digest("hex")
    });
    return res.status(201).json(response);
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

  app.get("/api/admin/reports/summary", authRequired, requireRole("STAFF"), (req, res) => {
    const accounts = store.accounts || [];
    const transactions = store.transactions || [];
    const loans = store.loans || [];
    const auditLogs = store.auditLogs || [];
    const deposits = transactions.filter(t => t.type === "DEPOSIT" && t.status === "SUCCESS");
    const withdrawals = transactions.filter(t => t.type === "WITHDRAWAL" && t.status === "SUCCESS");
    const transfersOut = transactions.filter(t => t.type === "TRANSFER_OUT" && t.status === "SUCCESS");
    const sum = (items) => Math.round(items.reduce((total, item) => total + Number(item.amount || 0), 0) * 100) / 100;
    const byType = {};
    for (const transaction of transactions) {
      const key = transaction.type || "UNKNOWN";
      byType[key] = (byType[key] || 0) + 1;
    }
    const generatedAt = now();
    audit("OPERATIONAL_REPORT_GENERATED", req.user.id, { report: "SUMMARY", generatedAt });
    return res.json({
      generatedAt,
      scope: "CURRENT_LOCAL_DEMO_STORE",
      accounts: {
        total: accounts.length,
        active: accounts.filter(a => a.status === "ACTIVE").length,
        frozen: accounts.filter(a => a.status === "FROZEN").length,
        closed: accounts.filter(a => a.status === "CLOSED").length,
        totalBalance: Math.round(accounts.reduce((total, account) => total + Number(account.balance || 0), 0) * 100) / 100
      },
      transactions: {
        total: transactions.length,
        deposits: deposits.length,
        depositAmount: sum(deposits),
        withdrawals: withdrawals.length,
        withdrawalAmount: sum(withdrawals),
        transfersOut: transfersOut.length,
        transferOutAmount: sum(transfersOut),
        countByType: byType
      },
      loans: {
        total: loans.length,
        pending: loans.filter(loan => loan.status === "PENDING").length,
        approved: loans.filter(loan => loan.status === "APPROVED").length,
        rejected: loans.filter(loan => loan.status === "REJECTED").length,
        paid: loans.filter(loan => loan.status === "PAID").length,
        outstandingBalance: Math.round(loans.reduce((total, loan) => total + Number(loan.outstandingBalance || 0), 0) * 100) / 100
      },
      auditEvents: auditLogs.length
    });
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
