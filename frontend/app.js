function readPendingWithdrawal() {
  try { return JSON.parse(sessionStorage.getItem("bmsPendingWithdrawal") || "null"); }
  catch { return null; }
}

const state = {
  token: localStorage.getItem("bmsToken"),
  pendingUserId: null,
  userRole: null,
  accounts: [],
  loans: [],
  // Kept in sessionStorage so refresh/retry after a timeout reuses the same request key.
  pendingWithdrawal: readPendingWithdrawal()
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

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function showLogin() {
  $("loginView").classList.remove("hidden");
  $("dashboardView").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
}

function showDashboard() {
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
    $("profileName").value = me.user.name;
    $("profilePhone").value = me.user.phone;

    const accounts = await api("/api/accounts");
    state.accounts = accounts.accounts;
    $("accountCards").innerHTML = state.accounts.map(a => `
      <div class="card">
        <div class="label">${a.type} • ${a.status}</div>
        <div class="value">₹${a.balance.toFixed(2)}</div>
        <small>A/C ${a.accountNumber}</small>
      </div>`).join("");
    const options = accountSelectOptions();
    ["depositAccount","withdrawAccount","transferAccount"].forEach(id => $(id).innerHTML = options);
    await loadTransactions();
    await loadBeneficiaries();
    await loadLoans();
    if (state.userRole === "STAFF") await loadOperationalReport();
    const health = await api("/api/health");
    $("apiStatus").textContent = `API ${health.status.toUpperCase()}`;
    showDashboard();
  } catch (e) {
    localStorage.removeItem("bmsToken"); state.token = null; showLogin();
    $("authMessage").textContent = e.message;
  }
}

async function loadTransactions() {
  const data = await api("/api/transactions");
  $("transactionBody").innerHTML = data.transactions.length ? data.transactions.map(t => `
    <tr><td>${new Date(t.createdAt).toLocaleString()}</td><td>${t.type}</td><td>₹${t.amount.toFixed(2)}</td><td>${t.status}</td><td>${escapeHtml(t.description)}</td></tr>`).join("")
    : '<tr><td colspan="5">No transactions yet.</td></tr>';
}

async function loadBeneficiaries() {
  const data = await api("/api/beneficiaries");
  $("beneficiaryList").innerHTML = data.beneficiaries.length ? data.beneficiaries.map(b => `
    <div class="list-item"><span>${escapeHtml(b.name)}<br><small>${b.accountNumber}</small></span>
    <button class="secondary" data-delete-beneficiary="${b.id}">Remove</button></div>`).join("") : "<p class='muted'>No beneficiaries yet.</p>";
  document.querySelectorAll("[data-delete-beneficiary]").forEach(btn => btn.onclick = async () => {
    try { await api("/api/beneficiaries/" + btn.dataset.deleteBeneficiary, { method: "DELETE" }); await loadBeneficiaries(); toast("Beneficiary removed"); }
    catch(e){ toast(e.message); }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
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
        <button type="button" data-loan-decision="APPROVED" data-loan-id="${escapeHtml(loan.id)}">Approve & disburse</button>
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
      <td>${escapeHtml(loan.status)}</td>
      <td>${loan.repaymentAmount == null ? "—" : Number(loan.repaymentAmount).toFixed(2)}</td>
      <td>${loan.outstandingBalance == null ? "—" : Number(loan.outstandingBalance).toFixed(2)}</td>
      <td>${action}</td>
    </tr>`;
  }).join("");

  document.querySelectorAll("[data-loan-decision]").forEach(button => {
    button.onclick = async () => {
      const loanId = button.dataset.loanId;
      const decision = button.dataset.loanDecision;
      const rate = document.querySelector(`[data-loan-rate="${loanId}"]`);
      const payload = { decision };
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
      try {
        await api("/api/loans/" + encodeURIComponent(loanId) + "/repayments", {
          method: "POST",
          body: JSON.stringify({ accountId: accountField.value, amount: Number(amountField.value) })
        });
        $("loansMessage").textContent = "Repayment recorded; account balance and loan outstanding updated.";
        await loadDashboard();
        toast("Loan repayment recorded");
      } catch (error) {
        $("loansMessage").textContent = error.message;
      }
    };
  });
}

async function loadOperationalReport() {
  const report = await api("/api/admin/reports/summary");
  $("operationalReportOutput").textContent = JSON.stringify(report, null, 2);
}

function newIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "withdraw-" + Date.now() + "-" + Math.random().toString(36).slice(2);
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

async function transaction(endpoint, accountField, amountField) {
  const accountId = $(accountField).value;
  const amount = Number($(amountField).value);
  const isWithdrawal = endpoint === "/api/transactions/withdraw";
  const headers = {};

  if (isWithdrawal) {
    const pending = state.pendingWithdrawal;
    if (!pending || pending.accountId !== accountId || pending.amount !== amount) {
      setPendingWithdrawal({ key: newIdempotencyKey(), accountId, amount });
    }
    headers["Idempotency-Key"] = state.pendingWithdrawal.key;
  }

  try {
    await api(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId, amount })
    });
    if (isWithdrawal) setPendingWithdrawal(null);
    $(amountField).value = "";
    await loadDashboard();
    toast("Transaction completed successfully");
  } catch(e) {
    // Keep the withdrawal key after a timeout/network error; submitting the same
    // account and amount again will safely replay the original server result.
    toast(e.message);
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

$("loginForm").onsubmit = login;
$("otpForm").onsubmit = verifyOtp;
$("depositForm").onsubmit = e => { e.preventDefault(); transaction("/api/transactions/deposit","depositAccount","depositAmount"); };
$("withdrawForm").onsubmit = e => { e.preventDefault(); transaction("/api/transactions/withdraw","withdrawAccount","withdrawAmount"); };
$("transferForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/api/transactions/transfer", {
      method:"POST",
      body:JSON.stringify({ fromAccountId:$("transferAccount").value, toAccountNumber:$("toAccount").value, amount:Number($("transferAmount").value) })
    });
    $("transferAmount").value = ""; $("toAccount").value = ""; await loadDashboard(); toast("Fund transfer completed");
  } catch(e){ toast(e.message); }
};
$("beneficiaryForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/api/beneficiaries", { method:"POST", body:JSON.stringify({name:$("beneficiaryName").value,accountNumber:$("beneficiaryAccount").value}) });
    e.target.reset(); await loadBeneficiaries(); toast("Beneficiary added");
  } catch(e){ toast(e.message); }
};
$("profileForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/api/profile", { method:"PUT", body:JSON.stringify({name:$("profileName").value,phone:$("profilePhone").value}) });
    toast("Profile updated"); await loadDashboard();
  } catch(e){ toast(e.message); }
};
$("refreshBtn").onclick = loadDashboard;
$("logoutBtn").onclick = async () => {
  try { if (state.token) await api("/api/auth/logout", { method:"POST" }); } catch {}
  state.token = null; localStorage.removeItem("bmsToken"); state.pendingUserId = null; showLogin(); $("loginForm").classList.remove("hidden"); $("otpForm").classList.add("hidden"); toast("Logged out");
};

if (state.token) loadDashboard(); else showLogin();
