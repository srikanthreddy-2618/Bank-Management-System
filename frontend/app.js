function readPendingWithdrawal() {
  try { return JSON.parse(sessionStorage.getItem("bmsPendingWithdrawal") || "null"); }
  catch { return null; }
}

function readPendingDeposit() {
  try { return JSON.parse(sessionStorage.getItem("bmsPendingDeposit") || "null"); }
  catch { return null; }
}

function readPendingTransfer() {
  try { return JSON.parse(sessionStorage.getItem("bmsPendingTransfer") || "null"); }
  catch { return null; }
}

function readPendingLoanRepayments() {
  try { return JSON.parse(sessionStorage.getItem("bmsPendingLoanRepayments") || "{}"); }
  catch { return {}; }
}

const state = {
  token: localStorage.getItem("bmsToken"),
  pendingUserId: null,
  userRole: null,
  accounts: [],
  loans: [],
  // Kept in sessionStorage so refresh/retry after a timeout reuses the same request key.
  pendingWithdrawal: readPendingWithdrawal(),
  pendingDeposit: readPendingDeposit(),
  pendingTransfer: readPendingTransfer(),
  pendingLoanRepayments: readPendingLoanRepayments()
};
const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

const SUCCESS_TOAST_MS = 4000;
const ERROR_TOAST_MS = 8000; // errors stay long enough to be read and are announced as alerts
let toastTimer, errorToastTimer;

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), SUCCESS_TOAST_MS);
}

function toastError(message) {
  const el = $("errorToast"); el.textContent = "Error: " + message; el.classList.add("show");
  clearTimeout(errorToastTimer);
  errorToastTimer = setTimeout(() => el.classList.remove("show"), ERROR_TOAST_MS);
}

function showLogin() {
  document.body.classList.remove("authenticated");
  $("loginView").classList.remove("hidden");
  $("dashboardView").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
}

function showDashboard() {
  document.body.classList.add("authenticated");
  $("loginView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
}

async function login(event) {
  event.preventDefault();
  $("authMessage").textContent = "";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: $("email").value, password: $("password").value })
    });
    state.pendingUserId = data.userId;
    $("otpHint").textContent = data.demoOtp
      ? `Demo mode: OTP is ${data.demoOtp}. It is never written to application logs.`
      : `OTP sent to ${data.destination}`;
    $("otp").value = data.demoOtp || "";
    $("loginForm").classList.add("hidden");
    $("otpForm").classList.remove("hidden");
    $("otp").focus();
  } catch (e) { $("authMessage").textContent = e.message; }
}

async function verifyOtp(event) {
  event.preventDefault();
  try {
    const data = await api("/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ userId: state.pendingUserId, otp: $("otp").value })
    });
    state.token = data.token;
    localStorage.setItem("bmsToken", state.token);
    await loadDashboard();
    $("welcomeName").focus();
  } catch (e) { $("authMessage").textContent = e.message; }
}

function accountSelectOptions() {
  return state.accounts.map(a => `<option value="${a.id}">${a.accountNumber} — ₹${a.balance.toFixed(2)}</option>`).join("");
}

async function loadDashboard() {
  try {
    const me = await api("/api/me");
    state.userRole = me.user.role;
    $("welcomeName").textContent = `Welcome, ${me.user.name}`;
    $("roleText").textContent = `${me.user.role} • KYC ${me.user.kycStatus}`;
    $("loanApplicationForm").classList.toggle("hidden", state.userRole !== "CUSTOMER");
    $("operationalReportsPanel").classList.toggle("hidden", state.userRole !== "STAFF");
    $("auditTrailPanel").classList.toggle("hidden", state.userRole !== "STAFF");
    $("userAdminPanel").classList.toggle("hidden", state.userRole !== "STAFF");
    ["navReports","navAudit","navAdmin"].forEach(id => $(id).classList.toggle("hidden", state.userRole !== "STAFF"));
    $("sidebarRole").textContent = state.userRole === "STAFF" ? "Staff workspace" : "Customer workspace";
    $("profileName").value = me.user.name;
    $("profilePhone").value = me.user.phone;

    const accounts = await api("/api/accounts");
    state.accounts = accounts.accounts;
    const totalBalance = state.accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);
    $("totalBalanceValue").textContent = formatINR(totalBalance);
    const activeAccounts = state.accounts.filter(account => account.status === "ACTIVE").length;
    $("accountCountValue").textContent = `Across ${activeAccounts} active account${activeAccounts === 1 ? "" : "s"}`;
    $("accountCards").innerHTML = state.accounts.map(account => `
      <article class="card account-card">
        <div class="account-card-head">
          <span class="label">${escapeHtml(account.type)} ACCOUNT</span>
          <span class="account-state">${escapeHtml(account.status)}</span>
        </div>
        <div class="value">${formatINR(account.balance)}</div>
        <div class="card-foot">
          <small>•••• •••• ${escapeHtml(String(account.accountNumber).slice(-4))}</small>
          <span class="card-symbol" aria-hidden="true">◈</span>
        </div>
      </article>`).join("");
    const options = accountSelectOptions();
    ["depositAccount","withdrawAccount","transferAccount","statementAccount"].forEach(id => $(id).innerHTML = options);
    // Rebuild the history account filter but keep the user's current selection across refreshes.
    const previousHistoryAccount = $("historyAccount").value;
    $("historyAccount").innerHTML = '<option value="">All accounts</option>' + options;
    if (state.accounts.some(a => a.id === previousHistoryAccount)) $("historyAccount").value = previousHistoryAccount;
    await loadTransactions();
    await loadBeneficiaries();
    await loadLoans();
    if (state.userRole === "STAFF") {
      await loadOperationalReport();
      await loadAdminUsers();
    }
    const health = await api("/api/health");
    $("apiStatus").textContent = `API ${health.status.toUpperCase()}`;
    showDashboard();
  } catch (e) {
    localStorage.removeItem("bmsToken"); state.token = null; showLogin();
    $("authMessage").textContent = e.message;
  }
}

function historyQuery() {
  const params = new URLSearchParams();
  const accountId = $("historyAccount").value;
  const from = $("historyFrom").value;
  const to = $("historyTo").value;
  if (accountId) params.set("accountId", accountId);
  // Convert the chosen calendar days to the user's local day boundaries so the range matches what they see.
  if (from) params.set("from", new Date(from + "T00:00:00").toISOString());
  if (to) params.set("to", new Date(to + "T23:59:59.999").toISOString());
  const query = params.toString();
  return query ? "?" + query : "";
}

async function loadTransactions() {
  const query = historyQuery();
  const data = await api("/api/transactions" + query);
  const accountNumber = id => (state.accounts.find(a => a.id === id) || {}).accountNumber || id;
  $("transactionBody").innerHTML = data.transactions.length ? data.transactions.map(t => `
    <tr><td>${new Date(t.createdAt).toLocaleString()}</td><td>${escapeHtml(accountNumber(t.accountId))}</td><td>${t.type}</td><td>₹${t.amount.toFixed(2)}</td><td>${t.status}</td><td>${escapeHtml(t.description)}</td></tr>`).join("")
    : `<tr><td colspan="6">${query ? "No transactions match the selected filters." : "No transactions yet."}</td></tr>`;
}

async function loadBeneficiaries() {
  const data = await api("/api/beneficiaries");
  $("beneficiaryList").innerHTML = data.beneficiaries.length ? data.beneficiaries.map(b => `
    <div class="list-item"><span>${escapeHtml(b.name)}<br><small>${b.accountNumber}</small></span>
    <button type="button" class="secondary" data-delete-beneficiary="${b.id}" aria-label="Remove beneficiary ${escapeHtml(b.name)}">Remove</button></div>`).join("") : "<p class='muted'>No beneficiaries yet.</p>";
  document.querySelectorAll("[data-delete-beneficiary]").forEach(btn => btn.onclick = async () => {
    try { await api("/api/beneficiaries/" + btn.dataset.deleteBeneficiary, { method: "DELETE" }); await loadBeneficiaries(); toast("Beneficiary removed"); }
    catch(e){ toastError(e.message); }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

async function loadAccountStatement() {
  const accountId = $("statementAccount").value;
  if (!accountId) throw new Error("Select an account");
  const params = new URLSearchParams({ accountId });
  const from = $("statementFrom").value;
  const to = $("statementTo").value;
  if (from) params.set("from", new Date(from + "T00:00:00").toISOString());
  if (to) params.set("to", new Date(to + "T23:59:59.999").toISOString());
  if (from && to && from > to) throw new Error("The From date must not be after the To date");

  const data = await api("/api/accounts/" + encodeURIComponent(accountId) + "/statement?" + params.toString());
  const statement = data.statement;
  $("statementSummary").textContent =
    `Opening ₹${statement.openingBalance.toFixed(2)} • Credits ₹${statement.totalCredits.toFixed(2)} • Debits ₹${statement.totalDebits.toFixed(2)} • Closing ₹${statement.closingBalance.toFixed(2)}`;
  $("statementBody").innerHTML = statement.transactions.length
    ? statement.transactions.map(t => {
        const credit = ["DEPOSIT","TRANSFER_IN","LOAN_DISBURSEMENT"].includes(t.type) ? Number(t.amount) : 0;
        const debit = ["WITHDRAWAL","TRANSFER_OUT","LOAN_REPAYMENT"].includes(t.type) ? Number(t.amount) : 0;
        return `<tr><td>${new Date(t.createdAt).toLocaleString()}</td><td>${escapeHtml(t.type)}</td><td>₹${credit.toFixed(2)}</td><td>₹${debit.toFixed(2)}</td><td>₹${Number(t.balanceAfter).toFixed(2)}</td><td>${escapeHtml(t.description || "")}</td></tr>`;
      }).join("")
    : '<tr><td colspan="6">No transactions in the selected period.</td></tr>';
}

async function loadAdminUsers() {
  const data = await api("/api/admin/users");
  const customers = data.users.filter(user => user.role === "CUSTOMER");
  $("adminAccountCustomer").innerHTML = customers.length
    ? customers.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} — ${escapeHtml(user.email)}</option>`).join("")
    : '<option value="">No customers available</option>';

  $("adminUserBody").innerHTML = data.users.length
    ? data.users.map(user => {
        const locked = user.lockedUntil ? new Date(user.lockedUntil).toLocaleString() : "—";
        const roleOptions = `<option value="CUSTOMER" ${user.role === "CUSTOMER" ? "selected" : ""}>CUSTOMER</option><option value="STAFF" ${user.role === "STAFF" ? "selected" : ""}>STAFF</option>`;
        const action = user.id === "usr-staff-001" || user.id === "usr-customer-001"
          ? `<select data-role-user="${escapeHtml(user.id)}">${roleOptions}</select>`
          : `<select data-role-user="${escapeHtml(user.id)}">${roleOptions}</select>`;
        return `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${action}</td><td>${escapeHtml(user.kycStatus)}</td><td>${Number(user.accountCount)}</td><td>${escapeHtml(locked)}</td><td><button type="button" class="secondary" data-save-role="${escapeHtml(user.id)}">Save role</button></td></tr>`;
      }).join("")
    : '<tr><td colspan="7">No users found.</td></tr>';

  document.querySelectorAll("[data-save-role]").forEach(button => {
    button.onclick = async () => {
      const userId = button.dataset.saveRole;
      const role = document.querySelector(`[data-role-user="${userId}"]`).value;
      try {
        await api("/api/admin/users/" + encodeURIComponent(userId) + "/role", {
          method: "PATCH",
          body: JSON.stringify({ role })
        });
        await loadAdminUsers();
        toast("User role updated");
      } catch (error) {
        toastError(error.message);
      }
    };
  });
}

async function loadLoans() {
  const data = await api("/api/loans");
  state.loans = data.loans || [];
  const body = $("loansBody");
  if (!state.loans.length) {
    body.innerHTML = '<tr><td colspan="8">No loan applications yet.</td></tr>';
    return;
  }

  body.innerHTML = state.loans.map(loan => {
    let action = "—";
    if (state.userRole === "STAFF" && loan.status === "PENDING") {
      const disbursementOptions = state.accounts
        .filter(account => account.userId === loan.userId && account.status === "ACTIVE")
        .map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.accountNumber)} (₹${Number(account.balance).toFixed(2)})</option>`)
        .join("");
      action = `<div class="loan-actions">
        <label>Credit to applicant account<select data-disbursement-account="${escapeHtml(loan.id)}">${disbursementOptions}</select></label>
        <label>Annual rate (%)<input type="number" min="0" max="100" step="0.01" value="8.5" data-loan-rate="${escapeHtml(loan.id)}"></label>
        <label>Reason (required to reject or return)<input type="text" maxlength="240" data-loan-reason="${escapeHtml(loan.id)}"></label>
        <button type="button" data-loan-decision="APPROVED" data-loan-id="${escapeHtml(loan.id)}">Approve & disburse</button>
        <button type="button" class="secondary" data-loan-decision="RETURNED" data-loan-id="${escapeHtml(loan.id)}">Return to applicant</button>
        <button type="button" class="secondary" data-loan-decision="REJECTED" data-loan-id="${escapeHtml(loan.id)}">Reject</button>
      </div>`;
    } else if (state.userRole === "CUSTOMER" && loan.status === "APPROVED" && Number(loan.outstandingBalance) > 0) {
      const accounts = state.accounts.map(account =>
        `<option value="${escapeHtml(account.id)}">${escapeHtml(account.accountNumber)} (₹${Number(account.balance).toFixed(2)})</option>`
      ).join("");
      action = `<div class="loan-actions">
        <select aria-label="Repayment account for ${escapeHtml(loan.id)}" data-repay-account="${escapeHtml(loan.id)}">${accounts}</select>
        <input aria-label="Repayment amount for ${escapeHtml(loan.id)}" type="number" min="0.01" step="0.01" max="${Number(loan.outstandingBalance)}" placeholder="Repayment amount" data-repay-amount="${escapeHtml(loan.id)}">
        <button type="button" data-repay-loan="${escapeHtml(loan.id)}">Repay</button>
      </div>`;
    }
    return `<tr>
      <td>${new Date(loan.submittedAt).toLocaleString()}</td>
      <td>${Number(loan.amount).toFixed(2)}</td>
      <td>${Number(loan.tenureMonths)} months</td>
      <td><span>${escapeHtml(loan.purpose || "")}</span><br><small>${escapeHtml(loan.id)}</small></td>
      <td>${escapeHtml(loan.status)}${loan.decisionReason ? `<br><small>Reason: ${escapeHtml(loan.decisionReason)}</small>` : ""}</td>
      <td>${loan.repaymentAmount == null ? "—" : Number(loan.repaymentAmount).toFixed(2)}</td>
      <td>${loan.outstandingBalance == null ? "—" : Number(loan.outstandingBalance).toFixed(2)}${Array.isArray(loan.repaymentSchedule) && loan.repaymentSchedule.length ? `<br><details><summary>Schedule</summary><small>${loan.repaymentSchedule.map(item => `#${item.installmentNumber}: ₹${Number(item.amount).toFixed(2)}`).join(" • ")}</small></details>` : ""}</td>
      <td>${action}</td>
    </tr>`;
  }).join("");

  document.querySelectorAll("[data-loan-decision]").forEach(button => {
    button.onclick = async () => {
      const loanId = button.dataset.loanId;
      const decision = button.dataset.loanDecision;
      const rate = document.querySelector(`[data-loan-rate="${loanId}"]`);
      const payload = { decision };
      const reasonInput = document.querySelector(`[data-loan-reason="${loanId}"]`);
      const reason = reasonInput ? reasonInput.value.trim() : "";
      if (reason) payload.reason = reason;
      if (decision !== "APPROVED" && reason.length < 5) {
        $("loansMessage").textContent = "Enter a reason of at least 5 characters to reject or return an application.";
        return;
      }
      if (decision === "APPROVED") {
        payload.annualRatePercent = Number(rate.value);
        payload.disbursementAccountId = document.querySelector(`[data-disbursement-account="${loanId}"]`).value;
      }
      try {
        await api("/api/loans/" + encodeURIComponent(loanId) + "/decision", {
          method: "PATCH", body: JSON.stringify(payload)
        });
        $("loansMessage").textContent = "Loan application " + decision.toLowerCase() + ".";
        await loadLoans();
        toast("Loan decision saved");
      } catch (error) {
        $("loansMessage").textContent = error.message;
      }
    };
  });

  document.querySelectorAll("[data-repay-loan]").forEach(button => {
    button.onclick = async () => {
      const loanId = button.dataset.repayLoan;
      const accountField = document.querySelector(`[data-repay-account="${loanId}"]`);
      const amountField = document.querySelector(`[data-repay-amount="${loanId}"]`);
      const accountId = accountField.value;
      const amount = Number(amountField.value);
      const previous = state.pendingLoanRepayments[loanId];
      if (!previous || previous.accountId !== accountId || previous.amount !== amount) {
        setPendingLoanRepayment(loanId, { key: newIdempotencyKey(), accountId, amount });
      }
      const request = state.pendingLoanRepayments[loanId];
      try {
        await api("/api/loans/" + encodeURIComponent(loanId) + "/repayments", {
          method: "POST",
          headers: { "Idempotency-Key": request.key },
          body: JSON.stringify({ accountId, amount })
        });
        setPendingLoanRepayment(loanId, null);
        $("loansMessage").textContent = "Repayment recorded; account balance and loan outstanding updated.";
        await loadDashboard();
        toast("Loan repayment recorded");
      } catch (error) {
        $("loansMessage").textContent = error.message;
      }
    };
  });
}

function auditQuery() {
  const params = new URLSearchParams();
  const result = $("auditResult").value;
  const action = $("auditAction").value.trim().toUpperCase().replace(/\s+/g, "_");
  const from = $("auditFrom").value;
  const to = $("auditTo").value;
  if (result) params.set("result", result);
  if (action) params.set("action", action);
  if (from) params.set("from", new Date(from + "T00:00:00").toISOString());
  if (to) params.set("to", new Date(to + "T23:59:59.999").toISOString());
  params.set("limit", "100");
  return "?" + params.toString();
}

async function loadAuditTrail() {
  const data = await api("/api/admin/audit" + auditQuery());
  $("auditSummary").textContent = `Showing ${data.auditLogs.length} of ${data.total} matching records (newest first).`;
  $("auditBody").innerHTML = data.auditLogs.length ? data.auditLogs.map(log => `
    <tr><td>${new Date(log.timestamp).toLocaleString()}</td><td>${escapeHtml(log.userId || "—")}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.result)}</td><td><small>${escapeHtml(JSON.stringify(log.metadata || {}))}</small></td></tr>`).join("")
    : '<tr><td colspan="5">No audit records match the selected filters.</td></tr>';
}

async function loadAuditRetention() {
  const status = await api("/api/admin/audit/retention");
  const integrity = status.integrity;
  const outcome = integrity.verified
    ? `Integrity VERIFIED (${integrity.checked} chained records checked${integrity.legacyRecords ? `, ${integrity.legacyRecords} older records unchained` : ""})`
    : `Integrity FAILED at record ${integrity.brokenRecordId} (${integrity.reason})`;
  $("auditIntegrity").textContent = `Retention policy: ${status.retentionDays} days. ${status.totalRecords} records retained` +
    (status.oldestRecordAt ? ` since ${new Date(status.oldestRecordAt).toLocaleDateString()}` : "") +
    `; ${status.expiredRecords} past retention. ${outcome}.`;
}

function formatINR(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function reportBar(label, value, total, detail = "") {
  const amount = Math.max(0, Number(value || 0));
  const safeTotal = Math.max(1, Number(total || 0));
  const width = Math.max(amount > 0 ? 2 : 0, Math.min(100, amount / safeTotal * 100));
  return `<div class="report-stat"><span>${escapeHtml(label)}</span><strong>${amount.toLocaleString("en-IN")}${detail ? ` · ${escapeHtml(detail)}` : ""}</strong><div class="report-track"><div class="report-fill" style="width:${width.toFixed(1)}%"></div></div></div>`;
}

async function loadOperationalReport() {
  const report = await api("/api/admin/reports/summary");
  const accounts = report.accounts || {};
  const transactions = report.transactions || {};
  const loans = report.loans || {};
  const transactionTypes = transactions.countByType || {};
  const totalTransactions = Number(transactions.total || 0);
  const transactionTypeRows = Object.entries(transactionTypes).sort((a,b) => Number(b[1]) - Number(a[1]));
  const maxTypeCount = Math.max(1, ...transactionTypeRows.map(([,count]) => Number(count || 0)));
  const transactionBars = transactionTypeRows.length
    ? transactionTypeRows.map(([type,count]) => reportBar(type.replace(/_/g," ").toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()), count, maxTypeCount, "events")).join("")
    : '<p class="muted">No transaction activity recorded yet.</p>';
  const accountStatusBars = [
    reportBar("Active accounts", accounts.active, accounts.total),
    reportBar("Frozen accounts", accounts.frozen, accounts.total),
    reportBar("Closed accounts", accounts.closed, accounts.total)
  ].join("");
  const loanStatusBars = [
    reportBar("Approved", loans.approved, loans.total),
    reportBar("Pending", loans.pending, loans.total),
    reportBar("Rejected", loans.rejected, loans.total),
    reportBar("Paid", loans.paid, loans.total)
  ].join("");
  const generated = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : "Not available";
  $("operationalReportOutput").innerHTML = `
    <div class="report-kpis">
      <article class="report-kpi"><span class="report-kpi-label">TOTAL ACCOUNT BALANCE</span><strong class="report-kpi-value">${formatINR(accounts.totalBalance)}</strong><span class="report-kpi-note">${Number(accounts.total || 0)} accounts · ${Number(accounts.active || 0)} active</span></article>
      <article class="report-kpi"><span class="report-kpi-label">TRANSACTIONS</span><strong class="report-kpi-value">${totalTransactions.toLocaleString("en-IN")}</strong><span class="report-kpi-note">${Number(transactions.withdrawals || 0)} withdrawals · ${Number(transactions.deposits || 0)} deposits</span></article>
      <article class="report-kpi"><span class="report-kpi-label">LOAN PORTFOLIO</span><strong class="report-kpi-value">${Number(loans.total || 0).toLocaleString("en-IN")}</strong><span class="report-kpi-note">${Number(loans.approved || 0)} approved applications</span></article>
      <article class="report-kpi"><span class="report-kpi-label">AUDIT EVENTS</span><strong class="report-kpi-value">${Number(report.auditEvents || 0).toLocaleString("en-IN")}</strong><span class="report-kpi-note">Recorded security and banking events</span></article>
    </div>
    <div class="report-panels-grid">
      <section class="report-card"><h4>Account status</h4><div class="report-stat-list">${accountStatusBars}</div><p class="report-card-note">${Number(accounts.total || 0)} total accounts in the current demo store.</p></section>
      <section class="report-card"><h4>Transaction activity</h4><div class="report-stat-list">${transactionBars}</div><p class="report-card-note">Deposit volume: ${formatINR(transactions.depositAmount)} · Withdrawal volume: ${formatINR(transactions.withdrawalAmount)}</p></section>
      <section class="report-card"><h4>Loan portfolio</h4><div class="report-stat-list">${loanStatusBars}</div><p class="report-card-note">Outstanding repayment balance: <strong>${formatINR(loans.outstandingBalance)}</strong></p></section>
      <section class="report-card"><h4>Operational snapshot</h4><div class="report-operational-number">${Number(report.auditEvents || 0).toLocaleString("en-IN")}</div><p class="report-card-note">Audit events currently recorded. Data reflects the live local demo store, not a historical warehouse.</p></section>
    </div>
    <div class="report-footnote"><span>Scope: ${escapeHtml(report.scope || "CURRENT_LOCAL_DEMO_STORE")}</span><span>Generated: ${escapeHtml(generated)}</span></div>`;
}

function setPendingLoanRepayment(loanId, request) {
  if (request) state.pendingLoanRepayments[loanId] = request;
  else delete state.pendingLoanRepayments[loanId];
  try {
    sessionStorage.setItem("bmsPendingLoanRepayments", JSON.stringify(state.pendingLoanRepayments));
  } catch {
    // Keep same-page retry protection even if session storage is unavailable.
  }
}

function newIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "bms-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function setPendingWithdrawal(request) {
  state.pendingWithdrawal = request;
  try {
    if (request) sessionStorage.setItem("bmsPendingWithdrawal", JSON.stringify(request));
    else sessionStorage.removeItem("bmsPendingWithdrawal");
  } catch {
    // The in-memory key still protects same-page retries if session storage is unavailable.
  }
}

function setPendingDeposit(request) {
  state.pendingDeposit = request;
  try {
    if (request) sessionStorage.setItem("bmsPendingDeposit", JSON.stringify(request));
    else sessionStorage.removeItem("bmsPendingDeposit");
  } catch {
    // The in-memory key still protects same-page retries if session storage is unavailable.
  }
}

function setPendingTransfer(request) {
  state.pendingTransfer = request;
  try {
    if (request) sessionStorage.setItem("bmsPendingTransfer", JSON.stringify(request));
    else sessionStorage.removeItem("bmsPendingTransfer");
  } catch {
    // The in-memory key still protects same-page retries if session storage is unavailable.
  }
}

async function transaction(endpoint, accountField, amountField) {
  const accountId = $(accountField).value;
  const amount = Number($(amountField).value);
  const isWithdrawal = endpoint === "/api/transactions/withdraw";
  const isDeposit = endpoint === "/api/transactions/deposit";
  const headers = {};

  if (isWithdrawal) {
    const pending = state.pendingWithdrawal;
    if (!pending || pending.accountId !== accountId || pending.amount !== amount) {
      setPendingWithdrawal({ key: newIdempotencyKey(), accountId, amount });
    }
    headers["Idempotency-Key"] = state.pendingWithdrawal.key;
  }

  if (isDeposit) {
    const pending = state.pendingDeposit;
    if (!pending || pending.accountId !== accountId || pending.amount !== amount) {
      setPendingDeposit({ key: newIdempotencyKey(), accountId, amount });
    }
    headers["Idempotency-Key"] = state.pendingDeposit.key;
  }

  try {
    await api(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId, amount })
    });
    if (isWithdrawal) setPendingWithdrawal(null);
    if (isDeposit) setPendingDeposit(null);
    $(amountField).value = "";
    await loadDashboard();
    toast("Transaction completed successfully");
  } catch(e) {
    // Keep the deposit/withdrawal key after a timeout/network error; submitting the same
    // account and amount again will safely replay the original server result.
    toastError(e.message);
  }
}

$("loanApplicationForm").onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await api("/api/loans", {
      method: "POST",
      body: JSON.stringify({
        amount: Number($("loanAmount").value),
        tenureMonths: Number($("loanTenure").value),
        purpose: $("loanPurpose").value.trim()
      })
    });
    event.target.reset();
    $("loanTenure").value = "12";
    $("loansMessage").textContent = "Application submitted with ID " + result.loan.id + ". Status: PENDING.";
    await loadLoans();
    toast("Loan application submitted");
  } catch (error) {
    $("loansMessage").textContent = error.message;
  }
};
$("refreshLoansBtn").onclick = async () => {
  try { await loadLoans(); toast("Loans refreshed"); }
  catch (error) { $("loansMessage").textContent = error.message; }
};
$("refreshReportBtn").onclick = async () => {
  try { await loadOperationalReport(); toast("Operational report refreshed"); }
  catch (error) { $("operationalReportOutput").textContent = error.message; }
};
$("statementBtn").onclick = async () => {
  try { await loadAccountStatement(); toast("Account statement generated"); }
  catch (error) { toastError(error.message); }
};
$("refreshUsersBtn").onclick = async () => {
  try { await loadAdminUsers(); toast("Users refreshed"); }
  catch (error) { toastError(error.message); }
};
$("adminUserForm").onsubmit = async event => {
  event.preventDefault();
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        name: $("adminUserName").value.trim(),
        email: $("adminUserEmail").value.trim(),
        phone: $("adminUserPhone").value.trim(),
        password: $("adminUserPassword").value,
        role: $("adminUserRole").value
      })
    });
    event.target.reset();
    await loadAdminUsers();
    $("adminUserMessage").textContent = "User created successfully.";
    toast("User created");
  } catch (error) {
    $("adminUserMessage").textContent = error.message;
    toastError(error.message);
  }
};
$("adminAccountForm").onsubmit = async event => {
  event.preventDefault();
  try {
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        userId: $("adminAccountCustomer").value,
        type: $("adminAccountType").value,
        initialDeposit: Number($("adminAccountInitialDeposit").value || 0)
      })
    });
    event.target.reset();
    $("adminAccountInitialDeposit").value = "0";
    $("adminUserMessage").textContent = "Account created successfully.";
    await loadAdminUsers();
    toast("Account created");
  } catch (error) {
    $("adminUserMessage").textContent = error.message;
    toastError(error.message);
  }
};

$("loginForm").onsubmit = login;
$("otpForm").onsubmit = verifyOtp;
$("depositForm").onsubmit = e => { e.preventDefault(); transaction("/api/transactions/deposit","depositAccount","depositAmount"); };
$("withdrawForm").onsubmit = e => { e.preventDefault(); transaction("/api/transactions/withdraw","withdrawAccount","withdrawAmount"); };
$("transferForm").onsubmit = async e => {
  e.preventDefault();
  const fromAccountId = $("transferAccount").value;
  const toAccountNumber = $("toAccount").value;
  const amount = Number($("transferAmount").value);
  // Reuse the same key when the same transfer is resubmitted after a timeout, so it posts only once.
  const pending = state.pendingTransfer;
  if (!pending || pending.fromAccountId !== fromAccountId || pending.toAccountNumber !== toAccountNumber || pending.amount !== amount) {
    setPendingTransfer({ key: newIdempotencyKey(), fromAccountId, toAccountNumber, amount });
  }
  try {
    await api("/api/transactions/transfer", {
      method:"POST",
      headers:{ "Idempotency-Key": state.pendingTransfer.key },
      body:JSON.stringify({ fromAccountId, toAccountNumber, amount })
    });
    setPendingTransfer(null);
    $("transferAmount").value = ""; $("toAccount").value = ""; await loadDashboard(); toast("Fund transfer completed");
  } catch(e){ toastError(e.message); }
};
$("beneficiaryForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/api/beneficiaries", { method:"POST", body:JSON.stringify({name:$("beneficiaryName").value,accountNumber:$("beneficiaryAccount").value}) });
    e.target.reset(); await loadBeneficiaries(); toast("Beneficiary added");
  } catch(e){ toastError(e.message); }
};
$("profileForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/api/profile", { method:"PUT", body:JSON.stringify({name:$("profileName").value,phone:$("profilePhone").value}) });
    toast("Profile updated"); await loadDashboard();
  } catch(e){ toastError(e.message); }
};
$("refreshBtn").onclick = loadDashboard;
$("historyFilterForm").onsubmit = async e => {
  e.preventDefault();
  if ($("historyFrom").value && $("historyTo").value && $("historyFrom").value > $("historyTo").value) {
    toastError("The From date must not be after the To date");
    return;
  }
  try { await loadTransactions(); } catch(err) { toastError(err.message); }
};
$("auditIntegrityBtn").onclick = async () => {
  try { await loadAuditRetention(); } catch(err) { toastError(err.message); }
};
$("auditFilterForm").onsubmit = async e => {
  e.preventDefault();
  if ($("auditFrom").value && $("auditTo").value && $("auditFrom").value > $("auditTo").value) {
    toastError("The From date must not be after the To date");
    return;
  }
  try { await loadAuditTrail(); } catch(err) { toastError(err.message); }
};
$("historyClear").onclick = async () => {
  $("historyAccount").value = ""; $("historyFrom").value = ""; $("historyTo").value = "";
  try { await loadTransactions(); } catch(err) { toastError(err.message); }
};
$("logoutBtn").onclick = async () => {
  try { if (state.token) await api("/api/auth/logout", { method:"POST" }); } catch {}
  state.token = null; localStorage.removeItem("bmsToken"); state.pendingUserId = null; showLogin(); $("loginForm").classList.remove("hidden"); $("otpForm").classList.add("hidden"); toast("Logged out");
};

document.querySelectorAll(".side-nav a").forEach(link => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".side-nav a").forEach(item => item.classList.remove("active"));
    link.classList.add("active");
  });
});

if (state.token) loadDashboard(); else showLogin();
