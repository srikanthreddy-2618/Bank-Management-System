const state = { token: localStorage.getItem("bmsToken"), pendingUserId: null, accounts: [] };
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
    $("welcomeName").textContent = `Welcome, ${me.user.name}`;
    $("roleText").textContent = `${me.user.role} • KYC ${me.user.kycStatus}`;
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

async function transaction(endpoint, accountField, amountField) {
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify({ accountId: $(accountField).value, amount: Number($(amountField).value) }) });
    $(amountField).value = ""; await loadDashboard(); toast("Transaction completed successfully");
  } catch(e){ toast(e.message); }
}

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
