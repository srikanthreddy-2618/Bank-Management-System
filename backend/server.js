const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
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
// Per-transfer limit. The SRS leaves the value to stakeholders, so this default is provisional.
const TRANSFER_LIMIT = Number(process.env.BMS_TRANSFER_LIMIT) > 0 ? Number(process.env.BMS_TRANSFER_LIMIT) : 200000;
const JWT_SECRET = process.env.BMS_JWT_SECRET || crypto.randomBytes(32).toString("hex");
const STORE_ENCRYPTION_KEY = process.env.BMS_STORE_ENCRYPTION_KEY || "";
const MIN_STORE_KEY_LENGTH = 32;
const TLS_KEY_FILE = process.env.BMS_TLS_KEY_FILE || "";
const TLS_CERT_FILE = process.env.BMS_TLS_CERT_FILE || "";
const TLS_CA_FILE = process.env.BMS_TLS_CA_FILE || "";

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

function storeCipherKey() {
  return crypto.createHash("sha256").update(STORE_ENCRYPTION_KEY).digest();
}

function serializeStore(value) {
  const plaintext = JSON.stringify(value, null, 2);
  if (!STORE_ENCRYPTION_KEY) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", storeCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc:v1", iv.toString("hex"), tag.toString("hex"), encrypted.toString("base64")].join(":");
}

function deserializeStore(raw) {
  if (!raw.startsWith("enc:v1:")) return JSON.parse(raw);
  if (!STORE_ENCRYPTION_KEY) throw new Error("BMS_STORE_ENCRYPTION_KEY is required to decrypt the configured data store");
  const [, version, ivHex, tagHex, payload] = raw.split(":");
  if (version !== "v1" || !ivHex || !tagHex || !payload) throw new Error("Invalid encrypted BMS data store");
  const decipher = crypto.createDecipheriv("aes-256-gcm", storeCipherKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload, "base64")),
    decipher.final()
  ]).toString("utf8"));
}

function requireStoreEncryption() {
  if (!PERSISTENCE) return;
  if (!STORE_ENCRYPTION_KEY) {
    throw new Error("BMS_STORE_ENCRYPTION_KEY is required when persistence is enabled");
  }
  if (STORE_ENCRYPTION_KEY.length < MIN_STORE_KEY_LENGTH) {
    throw new Error(`BMS_STORE_ENCRYPTION_KEY must be at least ${MIN_STORE_KEY_LENGTH} characters when persistence is enabled`);
  }
}

function normalizeStore(loaded) {
  if (!loaded || typeof loaded !== "object") throw new Error("Invalid BMS data store");
  if (!loaded.idempotencyKeys || typeof loaded.idempotencyKeys !== "object") loaded.idempotencyKeys = {};
  if (!loaded.otps || typeof loaded.otps !== "object") loaded.otps = {};
  if (!Array.isArray(loaded.loans)) loaded.loans = [];
  return loaded;
}

function loadStore() {
  if (!PERSISTENCE) return seedStore();
  requireStoreEncryption();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = seedStore();
    fs.writeFileSync(DATA_FILE, serializeStore(initial));
    return initial;
  }
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  try {
    const loaded = normalizeStore(deserializeStore(raw));
    // Existing academic demo JSON stores are migrated to encrypted-at-rest storage
    // on the first encrypted startup. New writes are always encrypted.
    if (!raw.startsWith("enc:v1:")) {
      fs.writeFileSync(DATA_FILE, serializeStore(loaded));
    }
    return loaded;
  } catch (error) {
    // Never replace an encrypted store after a key/decryption failure.
    if (raw.startsWith("enc:v1:")) throw error;
    throw new Error("Unable to load the persistent BMS store securely: " + error.message);
  }
}

let store = loadStore();

function saveStore() {
  if (!PERSISTENCE) return;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  // Atomic rename reduces the chance of leaving a partially written JSON store.
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, serializeStore(store));
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

// BMS-F-020: every audit record states its outcome. Actions that record a refused, failed, blocked or
// conflicting attempt are FAILURE; everything else (including idempotent replays) is SUCCESS.
function auditResult(action) {
  return /_(REJECTED|FAILED|BLOCKED|DENIED|CONFLICT)$/.test(String(action)) ? "FAILURE" : "SUCCESS";
}

// BMS-NF-004: retention period for audit records. The SRS leaves the period to organizational policy, so
// this default (7 years) is provisional and can be changed with BMS_AUDIT_RETENTION_DAYS.
const DEFAULT_AUDIT_RETENTION_DAYS = 2555;
function auditRetentionDays() {
  const days = Number(process.env.BMS_AUDIT_RETENTION_DAYS);
  return Number.isInteger(days) && days >= 1 ? days : DEFAULT_AUDIT_RETENTION_DAYS;
}

// Each record is chained to the one before it, so editing, removing or reordering a record is detectable.
function auditHash(prevHash, record) {
  return crypto.createHash("sha256")
    .update(prevHash + "|" + JSON.stringify([record.id, record.action, record.userId, record.timestamp, record.result, record.metadata]))
    .digest("hex");
}

function audit(action, userId, metadata = {}, at = now()) {
  const logs = store.auditLogs;
  const last = logs[logs.length - 1];
  const record = {
    id: id("aud-"),
    action,
    userId: userId || null,
    timestamp: at,
    result: auditResult(action),
    metadata: sanitizeAuditMetadata(metadata)
  };
  record.prevHash = last ? (last.hash || "LEGACY") : (store.auditAnchor || "GENESIS");
  record.hash = auditHash(record.prevHash, record);
  logs.push(record);
  saveStore();
}

// Walks the chain from the oldest retained record. Records written before hashing existed are counted as
// legacy and not verified; the first hashed record after them is trusted as the start of the chain.
function verifyAuditChain() {
  let expectedPrev = store.auditAnchor || "GENESIS";
  let checked = 0;
  let legacyRecords = 0;
  for (const record of store.auditLogs) {
    if (!record.hash) {
      legacyRecords += 1;
      expectedPrev = "LEGACY";
      continue;
    }
    if (record.prevHash !== expectedPrev) {
      return { verified: false, checked, legacyRecords, brokenRecordId: record.id, reason: "CHAIN_LINK_MISMATCH" };
    }
    if (auditHash(record.prevHash, record) !== record.hash) {
      return { verified: false, checked, legacyRecords, brokenRecordId: record.id, reason: "RECORD_MODIFIED" };
    }
    checked += 1;
    expectedPrev = record.hash;
  }
  return { verified: true, checked, legacyRecords, brokenRecordId: null, reason: null };
}

// Leading records older than the retention window. Only a contiguous run from the start of the chain is
// ever eligible, so the remaining chain stays verifiable.
function expiredAuditPrefix(referenceTime = Date.now()) {
  const cutoff = referenceTime - auditRetentionDays() * 86400000;
  let count = 0;
  while (count < store.auditLogs.length && Date.parse(store.auditLogs[count].timestamp) < cutoff) count += 1;
  return { count, cutoff: new Date(cutoff).toISOString() };
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
      audit("ACCESS_DENIED", req.user.id, { method: req.method, path: String(req.originalUrl || req.url).split("?")[0], role: req.user.role });
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
      decisionAt: null,
      decidedBy: null,
      decisionReason: null
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
    if (!["APPROVED", "REJECTED", "RETURNED"].includes(decision)) {
      return res.status(400).json({ error: "Decision must be APPROVED, REJECTED or RETURNED" });
    }
    // BMS-F-014: the decision records who decided, when, and why. A reason is mandatory when the
    // application is rejected or returned to the applicant, and optional on approval.
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (decision !== "APPROVED" && (reason.length < 5 || reason.length > 240)) {
      return res.status(400).json({ error: "A reason of 5-240 characters is required to reject or return an application" });
    }
    if (reason.length > 240) return res.status(400).json({ error: "Reason must be at most 240 characters" });

    let repaymentAmount = null;
    let outstandingBalance = null;
    let disbursementAccount = null;
    let disbursementTransaction = null;
    let annualRatePercent = null;
    let repaymentSchedule = [];


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
      let runningBalance = outstandingBalance;
      repaymentSchedule = Array.from({ length: loan.tenureMonths }, (_, index) => {
        const installment = index === loan.tenureMonths - 1
          ? Math.round(runningBalance * 100) / 100
          : repaymentAmount;
        runningBalance = Math.max(0, Math.round((runningBalance - installment) * 100) / 100);
        return {
          installmentNumber: index + 1,
          dueMonth: index + 1,
          amount: installment,
          outstandingAfter: runningBalance
        };
      });
    }

    loan.status = decision;
    loan.annualRatePercent = annualRatePercent;
    loan.repaymentAmount = repaymentAmount;
    loan.outstandingBalance = outstandingBalance;
    loan.repaymentSchedule = repaymentSchedule;
    loan.decisionAt = now();
    loan.decidedBy = req.user.id;
    loan.decisionReason = reason || null;

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
      : "Your loan application was " + decision.toLowerCase() + ". Reason: " + reason);
    saveStore();
    audit("LOAN_APPLICATION_DECIDED", req.user.id, {
      loanId: loan.id, decision, reason: reason || null, decidedAt: loan.decisionAt, repaymentAmount,
      disbursementAccountId: disbursementAccount?.id || null,
      disbursementTransactionId: disbursementTransaction?.id || null
    });
    return res.json({ loan, account: disbursementAccount ? publicAccount(disbursementAccount) : null, transaction: disbursementTransaction });
  });

  app.post("/api/loans/:id/repayments", authRequired, (req, res) => {
    const loan = (store.loans || []).find(item => item.id === req.params.id);
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (loan.userId !== req.user.id || req.user.role !== "CUSTOMER") return res.status(403).json({ error: "Only the loan holder can make a repayment" });

    const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : null;
    const amount = positiveAmount(req.body?.amount);
    const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      audit("LOAN_REPAYMENT_REJECTED", req.user.id, { loanId: loan.id, reason: "MISSING_OR_INVALID_IDEMPOTENCY_KEY" });
      return res.status(400).json({ error: "A valid Idempotency-Key header is required for loan repayments" });
    }

    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ loanId: loan.id, accountId, amount })).digest("hex");
    const scopedKey = req.user.id + ":loan-repayment:" + idempotencyKey;
    const previous = store.idempotencyKeys[scopedKey];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        audit("LOAN_REPAYMENT_IDEMPOTENCY_CONFLICT", req.user.id, { loanId: loan.id, reason: "KEY_REUSED_WITH_DIFFERENT_REQUEST" });
        return res.status(409).json({ error: "Idempotency-Key was already used for a different repayment request" });
      }
      audit("LOAN_REPAYMENT_IDEMPOTENT_REPLAY", req.user.id, { loanId: loan.id, transactionId: previous.response.transaction.id });
      return res.status(previous.statusCode || 201).json({ ...previous.response, idempotentReplay: true });
    }

    const reject = (status, error, reason) => {
      audit("LOAN_REPAYMENT_REJECTED", req.user.id, { loanId: loan.id, reason });
      return res.status(status).json({ error });
    };
    if (loan.status !== "APPROVED" || loan.outstandingBalance === null) {
      return reject(400, "Only approved loans can be repaid", "LOAN_NOT_APPROVED");
    }
    const account = ownedAccount(req.user, accountId);
    if (account === undefined) return reject(403, "Unauthorized repayment account", "UNAUTHORIZED_ACCOUNT");
    if (!account) return reject(404, "Repayment account not found", "ACCOUNT_NOT_FOUND");
    if (account.userId !== loan.userId) return reject(403, "Repayment account must belong to the loan holder", "ACCOUNT_NOT_OWNED");
    if (account.status !== "ACTIVE") return reject(400, "Repayment account is not active", "ACCOUNT_NOT_ACTIVE");
    if (!amount) return reject(400, "Repayment amount must be positive", "INVALID_AMOUNT");
    if (amount > loan.outstandingBalance + 0.0001) return reject(400, "Repayment exceeds outstanding balance", "AMOUNT_EXCEEDS_OUTSTANDING");
    if (account.balance < amount) return reject(400, "Insufficient funds in repayment account", "INSUFFICIENT_FUNDS");

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

    const response = { repayment, transaction, account: publicAccount(account), loan };
    // Save the replay snapshot, debit and ledger records together in the demo store.
    store.idempotencyKeys[scopedKey] = {
      fingerprint,
      statusCode: 201,
      response: JSON.parse(JSON.stringify(response)),
      createdAt: now()
    };
    saveStore();
    audit("LOAN_REPAYMENT_RECORDED", req.user.id, {
      loanId: loan.id, repaymentId: repayment.id, accountId: account.id, amount,
      outstandingAfter: loan.outstandingBalance,
      idempotencyKeyHash: crypto.createHash("sha256").update(idempotencyKey).digest("hex")
    });
    return res.status(201).json(response);
  });

  // Parses an ISO date (YYYY-MM-DD) or ISO timestamp query value. A date-only "to" runs to the end of that day (UTC).
  const parseHistoryBoundary = (value, endOfDay) => {
    if (value === undefined || value === "") return { value: null };
    if (typeof value !== "string") return { error: true };
    const text = value.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
    if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(text)) return { error: true };
    // Date parsing rolls impossible days (e.g. 31 Feb) forward, so check the calendar date explicitly.
    const [year, month, day] = text.slice(0, 10).split("-").map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return { error: true };
    const time = new Date(dateOnly ? text + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z") : text).getTime();
    return Number.isNaN(time) ? { error: true } : { value: time };
  };

  app.get("/api/transactions", authRequired, (req, res) => {
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : null;
    const accounts = store.accounts.filter(a => req.user.role === "STAFF" ? true : a.userId === req.user.id);
    const allowed = accountId ? accounts.filter(a => a.id === accountId).map(a => a.id) : accounts.map(a => a.id);
    if (accountId && allowed.length === 0) return res.status(403).json({ error: "Unauthorized account" });

    // Optional inclusive date range (BMS-F-011).
    const from = parseHistoryBoundary(req.query.from, false);
    const to = parseHistoryBoundary(req.query.to, true);
    if (from.error || to.error) {
      return res.status(400).json({ error: "from and to must be ISO dates (YYYY-MM-DD) or ISO timestamps" });
    }
    if (from.value !== null && to.value !== null && from.value > to.value) {
      return res.status(400).json({ error: "from must not be after to" });
    }

    // Return only entries that belong to the selected account(s). Matching the counterparty as well would
    // expose the other party's ledger row (including its balance) on every transfer.
    const transactions = store.transactions.filter(t => {
      if (!allowed.includes(t.accountId)) return false;
      const created = Date.parse(t.createdAt);
      if (from.value !== null && created < from.value) return false;
      if (to.value !== null && created > to.value) return false;
      return true;
    });
    res.json({ transactions: transactions.sort((a,b) => b.createdAt.localeCompare(a.createdAt)) });
  });

  app.get("/api/accounts/:id/statement", authRequired, (req, res) => {
    const account = store.accounts.find(item => item.id === req.params.id);
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (req.user.role !== "STAFF" && account.userId !== req.user.id) {
      audit("ACCESS_DENIED", req.user.id, { method: req.method, path: "/api/accounts/:id/statement", role: req.user.role });
      return res.status(403).json({ error: "Unauthorized account" });
    }

    const from = parseHistoryBoundary(req.query.from, false);
    const to = parseHistoryBoundary(req.query.to, true);
    if (from.error || to.error) return res.status(400).json({ error: "from and to must be ISO dates (YYYY-MM-DD) or ISO timestamps" });
    if (from.value !== null && to.value !== null && from.value > to.value) return res.status(400).json({ error: "from must not be after to" });

    const signedAmount = transaction => (
      ["WITHDRAWAL", "TRANSFER_OUT", "LOAN_REPAYMENT"].includes(transaction.type)
        ? -Number(transaction.amount || 0)
        : Number(transaction.amount || 0)
    );
    const all = store.transactions
      .filter(transaction => transaction.accountId === account.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const filtered = all.filter(transaction => {
      const created = Date.parse(transaction.createdAt);
      return (from.value === null || created >= from.value) && (to.value === null || created <= to.value);
    });

    let openingBalance = all.length ? Math.round((all[0].balanceAfter - signedAmount(all[0])) * 100) / 100 : Number(account.balance || 0);
    if (from.value !== null) {
      const before = all.filter(transaction => Date.parse(transaction.createdAt) < from.value).at(-1);
      openingBalance = before
        ? Number(before.balanceAfter)
        : (filtered[0] ? Math.round((filtered[0].balanceAfter - signedAmount(filtered[0])) * 100) / 100 : Number(account.balance || 0));
    }

    const credits = filtered.filter(t => signedAmount(t) >= 0).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const debits = filtered.filter(t => signedAmount(t) < 0).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const closingBalance = filtered.length ? Number(filtered[filtered.length - 1].balanceAfter) : openingBalance;

    res.json({
      statement: {
        generatedAt: now(),
        account: publicAccount(account),
        period: { from: from.value === null ? null : new Date(from.value).toISOString(), to: to.value === null ? null : new Date(to.value).toISOString() },
        openingBalance: Math.round(openingBalance * 100) / 100,
        totalCredits: Math.round(credits * 100) / 100,
        totalDebits: Math.round(debits * 100) / 100,
        closingBalance: Math.round(closingBalance * 100) / 100,
        transactions: filtered.reverse()
      }
    });
    audit("ACCOUNT_STATEMENT_GENERATED", req.user.id, { accountId: account.id });
  });

  app.post("/api/transactions/deposit", authRequired, (req, res) => {
    const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : null;
    const amount = positiveAmount(req.body?.amount);
    const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();

    // Require a client-generated key so a retried request can never credit an account twice (BMS-F-007).
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      audit("CASH_DEPOSIT_REJECTED", req.user.id, { reason: "MISSING_OR_INVALID_IDEMPOTENCY_KEY" });
      return res.status(400).json({ error: "A valid Idempotency-Key header is required for deposits" });
    }

    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ accountId, amount }))
      .digest("hex");
    // Scope keys to the authenticated user and deposit operation.
    const scopedKey = req.user.id + ":deposit:" + idempotencyKey;
    const previous = store.idempotencyKeys[scopedKey];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        audit("CASH_DEPOSIT_IDEMPOTENCY_CONFLICT", req.user.id, {
          accountId, reason: "KEY_REUSED_WITH_DIFFERENT_REQUEST"
        });
        return res.status(409).json({ error: "Idempotency-Key was already used for a different deposit request" });
      }
      audit("CASH_DEPOSIT_IDEMPOTENT_REPLAY", req.user.id, {
        accountId, transactionId: previous.response.transaction.id
      });
      return res.status(previous.statusCode || 201).json({ ...previous.response, idempotentReplay: true });
    }

    const reject = (status, error, reason) => {
      const metadata = { reason };
      if (accountId && accountId.length <= 40) metadata.accountId = accountId;
      audit("CASH_DEPOSIT_REJECTED", req.user.id, metadata);
      return res.status(status).json({ error });
    };

    const account = ownedAccount(req.user, accountId);
    if (account === undefined) return reject(403, "Unauthorized account", "UNAUTHORIZED_ACCOUNT");
    if (!account) return reject(404, "Account not found", "ACCOUNT_NOT_FOUND");
    if (account.status !== "ACTIVE") return reject(400, "Account is not active", "ACCOUNT_NOT_ACTIVE");
    if (!amount) return reject(400, "Amount must be positive", "INVALID_AMOUNT");

    account.balance += amount;
    const transaction = {
      id: id("txn-"),
      accountId: account.id,
      type: "DEPOSIT",
      amount,
      balanceAfter: account.balance,
      description: req.body?.description || "Cash deposit",
      createdAt: now(),
      status: "SUCCESS"
    };
    store.transactions.push(transaction);
    addNotification(account.userId, "Deposit successful", `₹${amount.toFixed(2)} was deposited into account ${account.accountNumber}.`);

    const response = { transaction, account: publicAccount(account) };
    // Persist the credit, transaction and idempotency result together in the demo store.
    store.idempotencyKeys[scopedKey] = { fingerprint, statusCode: 201, response, createdAt: now() };
    saveStore();
    audit("CASH_DEPOSIT", req.user.id, {
      accountId: account.id, amount, transactionId: transaction.id,
      idempotencyKeyHash: crypto.createHash("sha256").update(idempotencyKey).digest("hex")
    });
    return res.status(201).json(response);
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
    const fromAccountId = typeof req.body?.fromAccountId === "string" ? req.body.fromAccountId : null;
    const toAccountNumber = String(req.body?.toAccountNumber || "");
    const amount = positiveAmount(req.body?.amount);
    const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();

    // Require a client-generated key so a retried request can never move the money twice (BMS-F-009).
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      audit("FUND_TRANSFER_REJECTED", req.user.id, { reason: "MISSING_OR_INVALID_IDEMPOTENCY_KEY" });
      return res.status(400).json({ error: "A valid Idempotency-Key header is required for transfers" });
    }

    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ fromAccountId, toAccountNumber, amount }))
      .digest("hex");
    // Scope keys to the authenticated user and transfer operation.
    const scopedKey = req.user.id + ":transfer:" + idempotencyKey;
    const previous = store.idempotencyKeys[scopedKey];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        audit("FUND_TRANSFER_IDEMPOTENCY_CONFLICT", req.user.id, {
          sourceAccountId: fromAccountId, reason: "KEY_REUSED_WITH_DIFFERENT_REQUEST"
        });
        return res.status(409).json({ error: "Idempotency-Key was already used for a different transfer request" });
      }
      audit("FUND_TRANSFER_IDEMPOTENT_REPLAY", req.user.id, {
        sourceAccountId: fromAccountId, transactionId: previous.response.transaction.id
      });
      return res.status(previous.statusCode || 201).json({ ...previous.response, idempotentReplay: true });
    }

    const reject = (status, error, reason) => {
      const metadata = { reason };
      if (fromAccountId && fromAccountId.length <= 40) metadata.sourceAccountId = fromAccountId;
      audit("FUND_TRANSFER_REJECTED", req.user.id, metadata);
      return res.status(status).json({ error });
    };

    const source = ownedAccount(req.user, fromAccountId);
    if (source === undefined) return reject(403, "Unauthorized source account", "UNAUTHORIZED_ACCOUNT");
    if (!source) return reject(404, "Source account not found", "SOURCE_NOT_FOUND");
    const destination = store.accounts.find(a => a.accountNumber === toAccountNumber);
    if (!destination) return reject(404, "Destination account not found", "DESTINATION_NOT_FOUND");
    if (source.id === destination.id) return reject(400, "Source and destination accounts must differ", "SAME_ACCOUNT");
    if (source.status !== "ACTIVE" || destination.status !== "ACTIVE") return reject(400, "Both accounts must be active", "ACCOUNT_NOT_ACTIVE");
    if (!amount) return reject(400, "Amount must be positive", "INVALID_AMOUNT");
    if (amount > TRANSFER_LIMIT) return reject(400, "Amount exceeds the per-transfer limit of ₹" + TRANSFER_LIMIT.toFixed(2), "TRANSFER_LIMIT_EXCEEDED");
    if (source.balance < amount) return reject(400, "Insufficient balance", "INSUFFICIENT_BALANCE");

    // All validation is complete: apply both legs, the ledger entries and the idempotency
    // record in one synchronous block so the transfer is all-or-nothing.
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
      description: req.body?.description || "Fund transfer",
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
      description: req.body?.description || "Fund transfer received",
      createdAt: timestamp,
      status: "SUCCESS"
    };
    store.transactions.push(outbound, inbound);
    addNotification(source.userId, "Transfer successful", `₹${amount.toFixed(2)} was transferred to ${destination.accountNumber}.`);
    addNotification(destination.userId, "Transfer received", `₹${amount.toFixed(2)} was received from account ${source.accountNumber}.`);

    const response = { transaction: outbound, account: publicAccount(source) };
    store.idempotencyKeys[scopedKey] = { fingerprint, statusCode: 201, response, createdAt: now() };
    saveStore();
    audit("FUND_TRANSFER", req.user.id, {
      sourceAccountId: source.id, destinationAccountId: destination.id, amount, transactionId: outbound.id,
      idempotencyKeyHash: crypto.createHash("sha256").update(idempotencyKey).digest("hex")
    });
    return res.status(201).json(response);
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

  app.get("/api/admin/users", authRequired, requireRole("STAFF"), (_req, res) => {
    const users = store.users.map(user => ({
      ...publicUser(user),
      createdAt: user.createdAt,
      accountCount: store.accounts.filter(account => account.userId === user.id).length,
      lockedUntil: user.lockedUntil || null
    }));
    res.json({ users });
  });

  app.post("/api/admin/users", authRequired, requireRole("STAFF"), (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "CUSTOMER").toUpperCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "A valid email is required" });
    if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Name must be between 2 and 120 characters" });
    if (!/^\d{7,15}$/.test(phone)) return res.status(400).json({ error: "Phone must contain 7-15 digits" });
    if (password.length < 8) return res.status(400).json({ error: "Password must contain at least 8 characters" });
    if (!["CUSTOMER", "STAFF"].includes(role)) return res.status(400).json({ error: "Role must be CUSTOMER or STAFF" });
    if (store.users.some(user => user.email.toLowerCase() === email)) return res.status(409).json({ error: "Email already exists" });

    const passwordRecord = hashPassword(password);
    const user = {
      id: id("usr-"),
      email,
      name,
      role,
      phone,
      failedAttempts: 0,
      lockedUntil: null,
      password: passwordRecord,
      kycStatus: "PENDING",
      createdAt: now()
    };
    store.users.push(user);
    saveStore();
    audit("ADMIN_USER_CREATED", req.user.id, { targetUserId: user.id, role });
    return res.status(201).json({ user: publicUser(user) });
  });

  app.patch("/api/admin/users/:id/role", authRequired, requireRole("STAFF"), (req, res) => {
    const user = store.users.find(item => item.id === req.params.id);
    const role = String(req.body?.role || "").toUpperCase();
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.id === req.user.id) return res.status(400).json({ error: "You cannot change your own role" });
    if (!["CUSTOMER", "STAFF"].includes(role)) return res.status(400).json({ error: "Role must be CUSTOMER or STAFF" });
    const previousRole = user.role;
    user.role = role;
    saveStore();
    audit("ADMIN_USER_ROLE_CHANGED", req.user.id, { targetUserId: user.id, fromRole: previousRole, toRole: role });
    return res.json({ user: publicUser(user) });
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
        returned: loans.filter(loan => loan.status === "RETURNED").length,
        paid: loans.filter(loan => loan.status === "PAID").length,
        outstandingBalance: Math.round(loans.reduce((total, loan) => total + Number(loan.outstandingBalance || 0), 0) * 100) / 100
      },
      auditEvents: auditLogs.length
    });
  });

  app.get("/api/admin/audit", authRequired, requireRole("STAFF"), (req, res) => {
    const query = req.query;
    const text = (value, pattern) => value === undefined ? { value: null } : (typeof value === "string" && pattern.test(value) ? { value } : { error: true });
    const whole = (value, min, max, fallback) => {
      if (value === undefined) return { value: fallback };
      if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return { error: true };
      const number = Number(value);
      return number < min || number > max ? { error: true } : { value: number };
    };
    const userId = text(query.userId, /^[A-Za-z0-9._:-]{1,64}$/);
    const action = text(query.action, /^[A-Z][A-Z_]{0,63}$/);
    const result = text(query.result, /^(SUCCESS|FAILURE)$/);
    const from = parseHistoryBoundary(query.from, false);
    const to = parseHistoryBoundary(query.to, true);
    const limit = whole(query.limit, 1, 1000, 500);
    const offset = whole(query.offset, 0, 1000000, 0);
    if ([userId, action, result, from, to, limit, offset].some(item => item.error)) {
      return res.status(400).json({ error: "Invalid audit filter. Use userId, action (UPPER_CASE), result (SUCCESS or FAILURE), from/to (ISO dates), limit (1-1000) and offset." });
    }
    if (from.value !== null && to.value !== null && from.value > to.value) {
      return res.status(400).json({ error: "from must not be after to" });
    }

    const matching = store.auditLogs
      .map((log, index) => ({ id: log.id, action: log.action, userId: log.userId, timestamp: log.timestamp, result: log.result || auditResult(log.action), metadata: log.metadata, prevHash: log.prevHash || null, hash: log.hash || null, index }))
      .filter(log => (userId.value === null || log.userId === userId.value)
        && (action.value === null || log.action === action.value)
        && (result.value === null || log.result === result.value)
        && (from.value === null || Date.parse(log.timestamp) >= from.value)
        && (to.value === null || Date.parse(log.timestamp) <= to.value))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.index - a.index);
    const page = matching.slice(offset.value, offset.value + limit.value).map(({ index, ...log }) => log);

    // Reading the audit trail is itself a security-sensitive action.
    audit("AUDIT_LOG_VIEWED", req.user.id, {
      filters: { userId: userId.value, action: action.value, result: result.value, from: query.from || null, to: query.to || null },
      returned: page.length
    });
    res.json({ auditLogs: page, total: matching.length, limit: limit.value, offset: offset.value });
  });

  // BMS-NF-004: retention policy status plus a tamper-evidence check of the whole retained chain.
  app.get("/api/admin/audit/retention", authRequired, requireRole("STAFF"), (req, res) => {
    const integrity = verifyAuditChain();
    const logs = store.auditLogs;
    const expired = expiredAuditPrefix();
    const body = {
      retentionDays: auditRetentionDays(),
      cutoff: expired.cutoff,
      totalRecords: logs.length,
      oldestRecordAt: logs.length ? logs[0].timestamp : null,
      newestRecordAt: logs.length ? logs[logs.length - 1].timestamp : null,
      expiredRecords: expired.count,
      integrity
    };
    audit(integrity.verified ? "AUDIT_INTEGRITY_CHECKED" : "AUDIT_INTEGRITY_CHECK_FAILED", req.user.id, {
      checked: integrity.checked, brokenRecordId: integrity.brokenRecordId, reason: integrity.reason
    });
    res.json(body);
  });

  // Removes only records older than the retention period, and only on an explicit, audited staff request.
  app.post("/api/admin/audit/retention/purge", authRequired, requireRole("STAFF"), (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "Send { \"confirm\": true } to purge audit records older than the retention period" });
    }
    const expired = expiredAuditPrefix();
    if (expired.count > 0) {
      const removed = store.auditLogs.splice(0, expired.count);
      // The newest removed record becomes the anchor, so the retained chain still verifies.
      store.auditAnchor = removed[removed.length - 1].hash || "LEGACY";
    }
    audit("AUDIT_RETENTION_PURGED", req.user.id, {
      removed: expired.count, cutoff: expired.cutoff, retentionDays: auditRetentionDays()
    });
    res.json({ removed: expired.count, retentionDays: auditRetentionDays(), cutoff: expired.cutoff, remaining: store.auditLogs.length });
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
  const useTls = Boolean(TLS_KEY_FILE && TLS_CERT_FILE);
  let server;
  if (useTls) {
    const tlsOptions = {
      minVersion: "TLSv1.2",
      key: fs.readFileSync(TLS_KEY_FILE),
      cert: fs.readFileSync(TLS_CERT_FILE),
      ...(TLS_CA_FILE ? { ca: fs.readFileSync(TLS_CA_FILE) } : {})
    };
    server = https.createServer(tlsOptions, app);
  } else {
    server = http.createServer(app);
  }
  return new Promise(resolve => {
    server.listen(port, "0.0.0.0", () => {
      const protocol = useTls ? "https" : "http";
      console.log(`BMS server running on ${protocol}://0.0.0.0:${server.address().port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

// audit and getStore are exported so tests can write backdated records and simulate tampering.
module.exports = { createApp, startServer, seedStore, hashPassword, verifyPassword, audit, getStore: () => store };
