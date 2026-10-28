const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const testKey = [
  "encryption-test-key",
  "for-bms-persistence",
  "32-plus-chars"
].join("-");

function runServerLoad(extraEnv = {}) {
  return spawnSync(process.execPath, ["-e", "require('./backend/server')"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BMS_PERSISTENCE: "true",
      BMS_DEMO_MODE: "true",
      BMS_STORE_ENCRYPTION_KEY: testKey,
      ...extraEnv
    },
    encoding: "utf8"
  });
}

test("persistent mode refuses to start without an encryption key", () => {
  const result = runServerLoad({ BMS_STORE_ENCRYPTION_KEY: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /BMS_STORE_ENCRYPTION_KEY is required/);
});

test("persistent mode rejects a short encryption key", () => {
  const result = runServerLoad({ BMS_STORE_ENCRYPTION_KEY: "too-short" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /at least 32 characters/);
});

test("persistent store is encrypted at rest and decrypts with the correct key", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bms-encryption-"));
  const dataFile = path.join(tempDir, "db.json");

  try {
    const first = runServerLoad({ BMS_DATA_FILE: dataFile });
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const raw = fs.readFileSync(dataFile, "utf8");
    assert.match(raw, /^enc:v1:/);
    assert.equal(raw.includes("customer@bms.local"), false);
    assert.equal(raw.includes('"users"'), false);

    const second = runServerLoad({ BMS_DATA_FILE: dataFile });
    assert.equal(second.status, 0, second.stderr || second.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("wrong encryption key cannot replace or reset the encrypted store", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bms-encryption-wrong-key-"));
  const dataFile = path.join(tempDir, "db.json");

  try {
    const first = runServerLoad({ BMS_DATA_FILE: dataFile });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const before = fs.readFileSync(dataFile, "utf8");
    assert.match(before, /^enc:v1:/);

    const wrong = runServerLoad({
      BMS_DATA_FILE: dataFile,
      BMS_STORE_ENCRYPTION_KEY: ["different", "encryption", "key", "that", "is", "long", "enough"].join("-")
    });
    assert.notEqual(wrong.status, 0);
    const after = fs.readFileSync(dataFile, "utf8");
    assert.equal(after, before);
    assert.match(after, /^enc:v1:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy plaintext store is migrated to encrypted storage when the key is configured", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bms-encryption-migrate-"));
  const dataFile = path.join(tempDir, "db.json");

  try {
    const serverModule = require("../backend/server");
    const plainStore = serverModule.seedStore();
    fs.writeFileSync(dataFile, JSON.stringify(plainStore, null, 2));

    const migrated = runServerLoad({ BMS_DATA_FILE: dataFile });
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);

    const raw = fs.readFileSync(dataFile, "utf8");
    assert.match(raw, /^enc:v1:/);
    assert.equal(raw.includes("customer@bms.local"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
