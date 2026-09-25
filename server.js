"use strict";
// jdw-proxy - OpenAI to Anthropic translator for JustWorker gateway.
// Why this exists: api.justwoker.icu blocks POST /v1/chat/completions
// with Cloudflare 403, but POST /v1/messages works. OpenCode speaks
// OpenAI format, so this proxy translates in both directions.
// Zero dependencies, stdlib http only, Render free tier ready.
const http = require("http");
const https = require("https");
const PORT = parseInt(process.env.PORT || "18923", 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "api.justwoker.icu";
const UPSTREAM_PATH = process.env.UPSTREAM_PATH || "/v1/messages";
const UPSTREAM_KEY = process.env.JUSTWOKER_API_KEY || "";
const PROXY_TOKEN = process.env.PROXY_AUTH_TOKEN || "";
const BODY_LIMIT = parseInt(process.env.BODY_LIMIT_BYTES || "26214400", 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "120000", 10);
const MODELS = [
  { id: "gpt-5.6-terra", context: 1050000, output: 128000 },
  { id: "gpt-5.6-luna", context: 1050000, output: 128000 },
  { id: "gpt-5.6-sol", context: 1050000, output: 128000 }
];
let chatCounter = 0;
function nextId(prefix) {
  chatCounter = chatCounter + 1;
  return prefix + Date.now().toString() + "-" + chatCounter.toString();
}
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function sendJson(res, code, obj) {
  setCors(res);
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const parts = [];
    req.on("data", function (chunk) {
      size = size + chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(parts).toString("utf8")); });
    req.on("error", reject);
  });
}
function bearerKey(req) {
  const h = req.headers["authorization"] || "";
  if (h.indexOf("Bearer ") === 0) { return h.slice(7); }
  return "";
}
function checkProxyAuth(req, res) {
  if (!PROXY_TOKEN) { return true; }
  if (bearerKey(req) === PROXY_TOKEN) { return true; }
  sendJson(res, 401, { error: { message: "invalid proxy token", type: "auth_error" } });
  return false;
}
function resolveUpstreamKey(req) {
  if (UPSTREAM_KEY) { return UPSTREAM_KEY; }
  return bearerKey(req);
}
function convertContentToAnthropic(openaiContent) {
  if (typeof openaiContent === "string") { return openaiContent; }
  if (!Array.isArray(openaiContent)) { return ""; }
  const parts = [];
  for (const block of openaiContent) {
    if (!block || typeof block !== "object") { continue; }
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text || "" });
    } else if (block.type === "image_url" && block.image_url && block.image_url.url) {
      const url = block.image_url.url;
      if (url.indexOf("data:image/") === 0) {
        const comma = url.indexOf(",");
        const header = url.slice(0, comma);
        const b64 = url.slice(comma + 1);
        const m = header.match(/data:image\/([a-zA-Z0-9.+-]+)/);
        const mime = m ? ("image/" + m[1].toLowerCase()) : "image/jpeg";
        parts.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
      }
    } else if (block.type === "input_text" && block.text) {
      parts.push({ type: "text", text: block.text });
    }
  }
  if (parts.length === 0) { return ""; }
  if (parts.length === 1 && parts[0].type === "text") { return parts[0].text; }
  return parts;
}
function convertToolsToAnthropic(oaTools) {
  if (!Array.isArray(oaTools) || oaTools.length === 0) { return undefined; }
  const out = [];
  for (const t of oaTools) {
    if (t && t.type === "function" && t.function && t.function.name) {
      out.push({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} }
      });
    }
  }
  return out.length > 0 ? out : undefined;
}
function convertToolChoiceToAnthropic(choice) {
  if (choice === undefined || choice === null) { return undefined; }
  if (choice === "auto") { return { type: "auto" }; }
  if (choice === "none") { return { type: "none" }; }
  if (choice === "required") { return { type: "any" }; }
  if (typeof choice === "object" && choice.type === "function" && choice.function && choice.function.name) {
    return { type: "tool", name: choice.function.name };
  }
  return { type: "auto" };
}
function openaiMessagesToAnthropic(oaMessages) {
  let system = "";
  const systemParts = [];
  const messages = [];
  const list = Array.isArray(oaMessages) ? oaMessages : [];
  for (const m of list) {
    if (!m || typeof m !== "object") { continue; }
    const role = m.role || "user";
    if (role === "system") {
      const c = convertContentToAnthropic(m.content);
      if (typeof c === "string" && c) { systemParts.push(c); }
      else if (Array.isArray(c)) {
        for (const p of c) { if (p && p.type === "text" && p.text) { systemParts.push(p.text); } }
      }
      continue;
    }
    if (role === "tool") {
      const toolId = m.tool_call_id || m.id || nextId("toolu_");
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: text }]
      });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks = [];
      const tcText = typeof m.content === "string" ? m.content : "";
      if (tcText) { blocks.push({ type: "text", text: tcText }); }
      for (const tc of m.tool_calls) {
        const fn = (tc && tc.function) || {};
        let input = {};
        try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; }
        catch (e) { input = { raw: fn.arguments || "" }; }
        blocks.push({ type: "tool_use", id: tc.id || nextId("toolu_"), name: fn.name || "unknown", input: input });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    const content = convertContentToAnthropic(m.content);
    const outRole = role === "assistant" ? "assistant" : "user";
    messages.push({ role: outRole, content: content });
  }
  if (systemParts.length > 0) { system = systemParts.join("\n\n"); }
  return { system: system, messages: messages };
}
function upstreamMessages(antiBody, apiKey) {
  return new Promise(function (resolve, reject) {
    const payload = JSON.stringify(antiBody);
    const opts = {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: UPSTREAM_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": "Bearer " + apiKey
      }
    };
    const req = https.request(opts, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (parsed && parsed.error && parsed.error.message) || raw.slice(0, 500);
          const err = new Error("upstream " + res.statusCode + ": " + msg);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(UPSTREAM_TIMEOUT_MS, function () { req.destroy(new Error("upstream timeout")); });
    req.write(payload);
    req.end();
  });
}
function anthropicStopToOpenAI(stop) {
  if (stop === "max_tokens") { return "length"; }
  if (stop === "tool_use") { return "tool_calls"; }
  return "stop";
}
function anthropicToOpenAIResponse(anti, model) {
  const blocks = (anti && anti.content) || [];
  let text = "";
  const toolCalls = [];
  for (const b of blocks) {
    if (b && b.type === "text" && b.text) { text = text + b.text; }
    else if (b && b.type === "tool_use") {
      toolCalls.push({
        id: b.id || nextId("call_"),
        type: "function",
        function: { name: b.name || "unknown", arguments: JSON.stringify(b.input || {}) }
      });
    }
  }
  const finish = toolCalls.length > 0 ? "tool_calls" : anthropicStopToOpenAI(anti && anti.stop_reason);
  const usage = (anti && anti.usage) || {};
  return {
    id: nextId("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text, tool_calls: toolCalls.length > 0 ? toolCalls : undefined },
      finish_reason: finish
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
    }
  };
}
function sendOpenAIStream(res, completion) {
  setCors(res);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const msg = completion.choices[0].message || {};
  const finish = completion.choices[0].finish_reason || "stop";
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  function emit(delta, finishReason) {
    const chunk = JSON.stringify({
      id: base.id, object: base.object, created: base.created, model: base.model,
      choices: [{ index: 0, delta: delta, finish_reason: finishReason || null }]
    });
    res.write("data: " + chunk + "\n\n");
  }
  emit({ role: "assistant" }, null);
  if (msg.tool_calls) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      emit({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, null);
    }
  } else if (msg.content) {
    emit({ content: msg.content }, null);
  }
  emit({}, finish);
  res.write("data: [DONE]\n\n");
  res.end();
}
function pickMaxTokens(oa) {
  const v = oa.max_tokens || oa.max_completion_tokens || 1024;
  const n = parseInt(v, 10);
  if (!n || n < 1) { return 1024; }
  return Math.min(n, 128000);
}
async function handleChatCompletions(req, res) {
  if (!checkProxyAuth(req, res)) { return; }
  const apiKey = resolveUpstreamKey(req);
  if (!apiKey) {
    sendJson(res, 401, { error: { message: "missing API key: set JUSTWOKER_API_KEY on the server or send Authorization Bearer", type: "auth_error" } });
    return;
  }
  let oa = null;
  try {
    const raw = await readBody(req);
    oa = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request" } });
    return;
  }
  const model = oa.model || "gpt-5.6-sol";
  const conv = openaiMessagesToAnthropic(oa.messages);
  const antiBody = { model: model, max_tokens: pickMaxTokens(oa), messages: conv.messages };
  if (conv.system) { antiBody.system = conv.system; }
  const tools = convertToolsToAnthropic(oa.tools);
  if (tools) { antiBody.tools = tools; }
  const toolChoice = convertToolChoiceToAnthropic(oa.tool_choice);
  if (toolChoice) { antiBody.tool_choice = toolChoice; }
  if (typeof oa.temperature === "number") { antiBody.temperature = oa.temperature; }
  if (typeof oa.top_p === "number") { antiBody.top_p = oa.top_p; }
  let anti = null;
  try {
    anti = await upstreamMessages(antiBody, apiKey);
  } catch (e) {
    const code = e && e.status === 401 ? 401 : 502;
    sendJson(res, code, { error: { message: String((e && e.message) || e), type: "upstream_error" } });
    return;
  }
  const completion = anthropicToOpenAIResponse(anti, model);
  if (oa.stream) { sendOpenAIStream(res, completion); return; }
  sendJson(res, 200, completion);
}
async function handleLegacyCompletions(req, res) {
  if (!checkProxyAuth(req, res)) { return; }
  const apiKey = resolveUpstreamKey(req);
  if (!apiKey) {
    sendJson(res, 401, { error: { message: "missing API key", type: "auth_error" } });
    return;
  }
  let oa = null;
  try {
    const raw = await readBody(req);
    oa = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request" } });
    return;
  }
  const model = oa.model || "gpt-5.6-sol";
  const prompt = oa.prompt || "";
  const suffix = oa.suffix || "";
  const full = suffix ? (String(prompt) + String(suffix)) : String(prompt);
  const antiBody = { model: model, max_tokens: pickMaxTokens(oa), messages: [{ role: "user", content: full || "complete the code" }] };
  if (typeof oa.temperature === "number") { antiBody.temperature = oa.temperature; }
  let anti = null;
  try {
    anti = await upstreamMessages(antiBody, apiKey);
  } catch (e) {
    sendJson(res, 502, { error: { message: String((e && e.message) || e), type: "upstream_error" } });
    return;
  }
  const blocks = (anti && anti.content) || [];
  let text = "";
  for (const b of blocks) { if (b && b.type === "text" && b.text) { text = text + b.text; } }
  const usage = (anti && anti.usage) || {};
  const out = {
    id: nextId("cmpl-"),
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ text: text, index: 0, finish_reason: "stop" }],
    usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) }
  };
  if (oa.stream) {
    setCors(res);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("data: " + JSON.stringify(out) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  sendJson(res, 200, out);
}
function handleModels(req, res) {
  const data = MODELS.map(function (m) {
    return { id: m.id, object: "model", created: 1789135475, owned_by: "justworker", context_window: m.context, max_output_tokens: m.output };
  });
  sendJson(res, 200, { object: "list", data: data });
}
function handleHealth(req, res) {
  sendJson(res, 200, { ok: true, upstream: UPSTREAM_HOST + UPSTREAM_PATH, models: MODELS.map(function (m) { return m.id; }), auth: PROXY_TOKEN ? "token" : "open", time: new Date().toISOString() });
}
const server = http.createServer(function (req, res) {
  if (req.method === "OPTIONS") { setCors(res); res.writeHead(204); res.end(); return; }
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (url === "/health" || url === "/")) { handleHealth(req, res); return; }
  if (req.method === "GET" && url === "/v1/models") { handleModels(req, res); return; }
  if (req.method === "POST" && url === "/v1/chat/completions") { handleChatCompletions(req, res); return; }
  if (req.method === "POST" && (url === "/v1/completions" || url === "/completions")) { handleLegacyCompletions(req, res); return; }
  sendJson(res, 404, { error: { message: "not found: " + url, type: "not_found" } });
});
server.listen(PORT, "0.0.0.0", function () {
  console.log("jdw-proxy listening on " + PORT + " upstream " + UPSTREAM_HOST + UPSTREAM_PATH);
});
module.exports = server;
