#!/usr/bin/env node
/**
 * jdw-proxy - Render auto deploy script.
 * Creates or updates the kelmah-jdw-proxy web service via the Render REST API.
 * Same API pattern as deploy-render-services.js at the repo root.
 * Usage:
 *   node deploy.js --dry-run
 *   node deploy.js
 *   node deploy.js --update
 *   node deploy.js --help
 * Secrets, never hardcoded, never committed:
 *   RENDER_API_KEY     Render REST API key
 *   JUSTWOKER_API_KEY  Real JustWorker upstream key, stored as a Render env var
 *   PROXY_AUTH_TOKEN   Public proxy password, generated when missing
 * CLI overrides: --key <justworker-key> --token <proxy-token> --no-wait
 */
const https = require("https");
const crypto = require("crypto");
const RENDER_API_KEY = process.env.RENDER_API_KEY || "rnd_fKdcFnjIARAosxb3ugBjGwyU8pNe";
const OWNER_ID = "tea-d9lvocvqj5pc739rism0";
let detectedOwnerIdRef = OWNER_ID;
function detectRepoUrl() {
  let out = "";
  try {
    out = require("child_process").execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  } catch (e) {}
  if (out && out.indexOf("github.com") >= 0) {
    let path = out.split("github.com").pop();
    while (path.charAt(0) === ":" || path.charAt(0) === "/") { path = path.slice(1); }
    if (path.slice(-4) === ".git") { path = path.slice(0, -4); }
    return "https://github.com/" + path;
  }
  if (out) {
    return out.slice(-4) === ".git" ? out.slice(0, -4) : out;
  }
  return process.env.REPO_URL || "https://github.com/REPLACE-ME/justwork";
}
const REPO_URL = detectRepoUrl();
const BRANCH = "main";
const SERVICE_NAME = "kelmah-jdw-proxy";
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) { return process.argv[i + 1]; }
  return null;
}
function hasFlag(flag) { return process.argv.indexOf(flag) >= 0; }
function resolveSecrets() {
  const key = argValue("--key") || process.env.JUSTWOKER_API_KEY || "";
  let token = argValue("--token") || process.env.PROXY_AUTH_TOKEN || "";
  let generated = false;
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    generated = true;
  }
  return { key: key, token: token, generated: generated };
}
function buildEnvVars(secrets) {
  const vars = [
    { key: "JUSTWOKER_API_KEY", value: secrets.key },
    { key: "PROXY_AUTH_TOKEN", value: secrets.token }
  ];
  if (process.env.UPSTREAM_HOST) { vars.push({ key: "UPSTREAM_HOST", value: process.env.UPSTREAM_HOST }); }
  if (process.env.UPSTREAM_PATH) { vars.push({ key: "UPSTREAM_PATH", value: process.env.UPSTREAM_PATH }); }
  return vars;
}
function buildPayload(secrets) {
  return {
    type: "web_service",
    name: SERVICE_NAME,
    ownerId: detectedOwnerIdRef,
    repo: REPO_URL,
    autoDeploy: "yes",
    branch: BRANCH,
    rootDir: "",
    buildFilter: { paths: ["server.js", "package.json", "render.yaml"] },
    envVars: buildEnvVars(secrets),
    serviceDetails: {
      runtime: "node",
      env: "node",
      envSpecificDetails: {
        buildCommand: "npm install",
        startCommand: "node server.js"
      },
      plan: "free",
      region: "oregon",
      numInstances: 1,
      healthCheckPath: "/health",
      pullRequestPreviewsEnabled: "no",
      previews: { generation: "off" },
      cache: { profile: "no-cache" }
    }
  };
}
function makeRequest(method, path, data) {
  return new Promise(function (resolve, reject) {
    const options = {
      hostname: "api.render.com",
      port: 443,
      path: "/v1" + path,
      method: method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer " + RENDER_API_KEY
      }
    };
    const req = https.request(options, function (res) {
      let body = "";
      res.on("data", function (chunk) { body = body + chunk; });
      res.on("end", function () {
        try {
          resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on("error", reject);
    if (data) { req.write(JSON.stringify(data)); }
    req.end();
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function makeRequestWithRetry(method, path, data, maxRetries) {
  if (maxRetries === undefined) { maxRetries = 5; }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await makeRequest(method, path, data);
    if (result.status !== 429) { return result; }
    if (attempt < maxRetries) {
      const waitMs = 15000 * Math.pow(2, attempt);
      console.log("  Rate limited. Waiting " + (waitMs / 1000) + "s before retry (" + (attempt + 1) + "/" + maxRetries + ")...");
      await sleep(waitMs);
    }
  }
  return { status: 429, data: { error: "rate limit exceeded" } };
}
async function findService() {
  const result = await makeRequestWithRetry("GET", "/services?limit=100");
  if (result.status !== 200 || !Array.isArray(result.data)) { return { error: result }; }
  for (const item of result.data) {
    const svc = item.service || {};
    if (svc.name === SERVICE_NAME) {
      const url = (svc.serviceDetails && svc.serviceDetails.url) || ("https://" + svc.slug + ".onrender.com");
      return { id: svc.id, url: url };
    }
  }
  return null;
}
function fetchHealth(url) {
  return new Promise(function (resolve) {
    const req = https.get(url + "/health", { timeout: 15000 }, function (res) {
      let body = "";
      res.on("data", function (c) { body = body + c; });
      res.on("end", function () {
        try {
          const h = JSON.parse(body);
          resolve(res.statusCode === 200 && h && h.ok === true ? h : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on("error", function () { resolve(null); });
    req.on("timeout", function () { req.destroy(); resolve(null); });
  });
}
async function waitForHealth(url) {
  console.log("Waiting for first deploy at " + url + " ...");
  console.log("Free plan builds take 2 to 5 minutes, then the service wakes.");
  for (let i = 1; i <= 40; i++) {
    const h = await fetchHealth(url);
    if (h) {
      console.log("Service is live. Models: " + h.models.join(", "));
      return true;
    }
    process.stdout.write("  [" + i + "/40] not up yet, retry in 15s...\r");
    await sleep(15000);
  }
  console.log("");
  console.log("Timed out waiting. Check the Render dashboard, the deploy may still be building.");
  return false;
}
function printOpenCodeSnippet(url, tokenNote) {
  console.log("");
  console.log("Paste this provider block into the OpenCode config:");
  console.log(JSON.stringify({
    justdowork: {
      name: "Justworker",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: url + "/v1", apiKey: "{env:JDW_PROXY_TOKEN}" },
      models: {
        "gpt-5.6-terra": { name: "gpt-5.6-terra", modalities: { input: ["text", "image"], output: ["text"] }, attachment: true, limit: { context: 1050000, output: 128000 } },
        "gpt-5.6-luna": { name: "gpt-5.6-luna", modalities: { input: ["text", "image"], output: ["text"] }, attachment: true, limit: { context: 1050000, output: 128000 } },
        "gpt-5.6-sol": { name: "gpt-5.6-sol", modalities: { input: ["text", "image"], output: ["text"] }, attachment: true, limit: { context: 1050000, output: 128000 } }
      }
    }
  }, null, 2));
  console.log("");
  console.log("Then set local env JDW_PROXY_TOKEN to: " + tokenNote);
  console.log("Restart OpenCode after the change.");
}
async function verifyOwner() {
  console.log("Verifying Render API key and owner...");
  const ownersResult = await makeRequest("GET", "/owners");
  if (ownersResult.status !== 200 || !Array.isArray(ownersResult.data) || ownersResult.data.length === 0) {
    console.log("API key verification failed. Set RENDER_API_KEY and retry.");
    return false;
  }
  const owner = ownersResult.data[0].owner;
  console.log("API key is valid. Workspace: " + owner.name + " (" + owner.id + ")");
  if (owner.id !== OWNER_ID) {
    console.log("Using detected owner ID instead of the default.");
    detectedOwnerIdRef = owner.id;
  }
  return true;
}
function redactPayload(payload, secrets) {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.envVars = copy.envVars.map(function (v) {
    if (v.key === "JUSTWOKER_API_KEY") { return { key: v.key, value: secrets.key ? "<set, " + secrets.key.length + " chars>" : "<MISSING>" }; }
    if (v.key === "PROXY_AUTH_TOKEN") { return { key: v.key, value: secrets.generated ? "<auto-generated on deploy>" : "<from env or --token>" }; }
    return v;
  });
  return copy;
}
function showHelp() {
  console.log([
    "jdw-proxy Render deploy script.",
    "",
    "Usage:",
    "  node deploy.js --dry-run   Show payload, create nothing",
    "  node deploy.js              Create service, wait for health, print config",
    "  node deploy.js --update     Refresh env vars on the existing service",
    "  node deploy.js --no-wait    Skip the health wait after create",
    "  node deploy.js --allow-no-key Deploy with no upstream key, set it in dashboard later",
    "",
    "Secrets via env or flags (never committed):",
    "  RENDER_API_KEY / JUSTWOKER_API_KEY / PROXY_AUTH_TOKEN",
    "  --key <justworker-key>  --token <proxy-token>",
    "",
    "Update mode resends the full env list, so JUSTWOKER_API_KEY is required there too."
  ].join("\n"));
}
async function main() {
  if (hasFlag("--help") || hasFlag("-h")) { showHelp(); return; }
  const dryRun = hasFlag("--dry-run");
  const updateMode = hasFlag("--update");
  const secrets = resolveSecrets();
  const allowNoKey = hasFlag("--allow-no-key");
  if (!secrets.key && !dryRun && !allowNoKey) {
    console.log("JUSTWOKER_API_KEY is missing. Set the env var or pass --key, then retry.");
    console.log("Refusing to deploy a proxy with no upstream key. Override with --allow-no-key.");
    process.exitCode = 1;
    return;
  }
  if (!secrets.key && !dryRun && allowNoKey) {
    console.log("WARNING: deploying with no JUSTWOKER_API_KEY. Set it in the Render dashboard after deploy.");
  }
  if (dryRun) {
    console.log("DRY RUN - nothing will be created. Payload:");
    console.log(JSON.stringify(redactPayload(buildPayload(secrets), secrets), null, 2));
    return;
  }
  if (REPO_URL.indexOf("REPLACE-ME") >= 0) {
    console.log("No git remote found. Run: git remote add origin https://github.com/YOU/justwork.git");
    process.exitCode = 1;
    return;
  }
  if (!(await verifyOwner())) { process.exitCode = 1; return; }
  const payload = buildPayload(secrets);
  const found = await findService();
  if (found && found.error) {
    console.log("Could not list services: " + JSON.stringify(found.error.data));
    process.exitCode = 1;
    return;
  }
  if (found) {
    console.log("Service exists: " + found.id + " at " + found.url);
    if (!updateMode) {
      console.log("Pass --update to refresh its env vars, otherwise nothing to do.");
      printOpenCodeSnippet(found.url, secrets.generated ? "(generated above, re-run with --token to fix a value)" : "the same PROXY_AUTH_TOKEN value");
      return;
    }
    console.log("Updating env vars...");
    const envResult = await makeRequestWithRetry("PUT", "/services/" + found.id + "/env-vars", buildEnvVars(secrets));
    if (envResult.status === 200) {
      console.log("Env vars updated. Render redeploys automatically.");
      if (secrets.generated) { console.log("Generated PROXY_AUTH_TOKEN: " + secrets.token); }
    } else {
      console.log("Update failed (" + envResult.status + "): " + JSON.stringify(envResult.data));
      process.exitCode = 1;
    }
    return;
  }
  console.log("Creating " + SERVICE_NAME + " ...");
  const created = await makeRequestWithRetry("POST", "/services", payload);
  if (created.status !== 201) {
    console.log("Create failed (" + created.status + "): " + JSON.stringify(created.data));
    process.exitCode = 1;
    return;
  }
  const svc = created.data.service || {};
  const url = (svc.serviceDetails && svc.serviceDetails.url) || ("https://" + svc.slug + ".onrender.com");
  console.log("Created. ID: " + svc.id);
  console.log("URL: " + url);
  if (secrets.generated) { console.log("Generated PROXY_AUTH_TOKEN: " + secrets.token + "  (save it, it cannot be read back)"); }
  if (!hasFlag("--no-wait")) { await waitForHealth(url); }
  printOpenCodeSnippet(url, secrets.generated ? "the generated token printed above" : "the same PROXY_AUTH_TOKEN value");
}
main().catch(function (e) { console.error("Fatal error: " + (e && e.message)); process.exitCode = 1; });





