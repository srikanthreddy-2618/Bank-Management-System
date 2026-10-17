/* Repeatable local API latency baseline for BMS-NF-001.
 * Set BMS_PERFORMANCE_TARGET_MS to the exact SRS target when confirmed.
 */
process.env.BMS_PERSISTENCE = "false";
process.env.BMS_DEMO_MODE = "true";

const { performance } = require("node:perf_hooks");
const { createApp } = require("../backend/server");

const targetMs = Number(process.env.BMS_PERFORMANCE_TARGET_MS || 2000);
const iterations = Math.max(20, Math.min(500, Number(process.env.BMS_PERFORMANCE_ITERATIONS || 100)));

async function requestJson(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(path + " returned HTTP " + response.status + ": " + (body.error || "request failed"));
  return body;
}

async function main() {
  const app = createApp({ freshStore: true });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = "http://127.0.0.1:" + server.address().port;

  try {
    const login = await requestJson(base, "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "customer@bms.local", password: "Password@123" })
    });
    const customerAuth = await requestJson(base, "/api/auth/verify-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: login.userId, otp: "123456" })
    });
    const staffLogin = await requestJson(base, "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staff@bms.local", password: "Password@123" })
    });
    const staffAuth = await requestJson(base, "/api/auth/verify-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: staffLogin.userId, otp: "123456" })
    });

    const cases = [
      { name: "GET /api/health", path: "/api/health", token: null },
      { name: "GET /api/accounts (customer)", path: "/api/accounts", token: customerAuth.token },
      { name: "GET /api/admin/reports/summary (staff)", path: "/api/admin/reports/summary", token: staffAuth.token }
    ];
    const results = [];

    for (const testCase of cases) {
      for (let i = 0; i < 10; i++) {
        await requestJson(base, testCase.path, {
          headers: testCase.token ? { authorization: "Bearer " + testCase.token } : {}
        });
      }
      const elapsed = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await requestJson(base, testCase.path, {
          headers: testCase.token ? { authorization: "Bearer " + testCase.token } : {}
        });
        elapsed.push(performance.now() - start);
      }
      elapsed.sort((a, b) => a - b);
      const percentile = p => elapsed[Math.min(elapsed.length - 1, Math.ceil(p * elapsed.length) - 1)];
      const result = {
        endpoint: testCase.name,
        samples: iterations,
        medianMs: Number(percentile(0.5).toFixed(2)),
        p95Ms: Number(percentile(0.95).toFixed(2)),
        maxMs: Number(elapsed[elapsed.length - 1].toFixed(2)),
        targetMs,
        pass: percentile(0.95) <= targetMs
      };
      results.push(result);
    }

    console.log("BMS API performance baseline (local in-memory demo; no network/database included)");
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      node: process.version,
      iterationsPerEndpoint: iterations,
      targetSource: process.env.BMS_PERFORMANCE_TARGET_MS ? "BMS_PERFORMANCE_TARGET_MS environment setting" : "provisional default; confirm against submitted SRS",
      results
    }, null, 2));

    if (results.some(result => !result.pass)) process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
