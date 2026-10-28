const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync, spawn } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bms-tls-"));
const keyFile = path.join(tempDir, "server.key");
const certFile = path.join(tempDir, "server.crt");

try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile,
    "-out", certFile,
    "-subj", "/CN=localhost",
    "-days", "1"
  ], { stdio: "ignore" });

  const port = 3400 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["backend/server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      BMS_PERSISTENCE: "false",
      BMS_DEMO_MODE: "true",
      BMS_TLS_KEY_FILE: keyFile,
      BMS_TLS_CERT_FILE: certFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for HTTPS server"));
    }, 10000);

    const onData = chunk => {
      const text = chunk.toString();
      if (!text.includes("https://0.0.0.0:")) return;
      clearTimeout(timer);
      const request = https.get("https://127.0.0.1:" + port + "/api/health", {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2"
      }, response => {
        const protocol = response.socket?.getProtocol();
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error("HTTPS health endpoint returned " + response.statusCode);
            if (!JSON.parse(body).status) throw new Error("Health response was invalid");
            if (!["TLSv1.2", "TLSv1.3"].includes(protocol)) {
              throw new Error("Negotiated protocol " + protocol + " is below TLS 1.2");
            }
            resolve(protocol);
          } catch (error) {
            reject(error);
          } finally {
            child.kill("SIGTERM");
          }
        });
      });
      request.on("error", reject);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      if (text.includes("Error")) {
        clearTimeout(timer);
        reject(new Error(text.trim()));
      }
    });
    child.on("exit", code => {
      if (code && code !== 143) {
        clearTimeout(timer);
        reject(new Error("HTTPS server exited with code " + code));
      }
    });
  });

  result.then(protocol => {
    console.log("BMS TLS validation passed. Negotiated protocol:", protocol);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  }).finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
} catch (error) {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error("TLS validation setup failed:", error.message);
  process.exitCode = 1;
}
