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
const UPSTREAM_PROTO = process.env.UPSTREAM_PROTO || "https";
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || "443", 10);
const BODY_LIMIT = parseInt(process.env.BODY_LIMIT_BYTES || "26214400", 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "300000", 10);
// Model context numbers, env-overridable. Verified 2026-10-01 against
// https://api.justwoker.icu/v1 (New-API style gateway, /v1/models needs auth):
// max_tokens up to 128000 accepted, and the gateway reports ~6600 input
// tokens on a 6-word prompt, i.e. a fixed ~6.6k-token overhead per request.
// MODEL_OVERHEAD reserves that (rounded up) so guarded/advertised limits
// reflect usable context, not the raw upstream window.
const MODEL_CONTEXT = parseInt(process.env.MODEL_CONTEXT || "200000", 10);
const MODEL_OUTPUT = parseInt(process.env.MODEL_OUTPUT || "32000", 10);
const MODEL_OVERHEAD = parseInt(process.env.MODEL_OVERHEAD || "7000", 10);
const MODELS = [
  { id: "claude-opus-4-8", context: MODEL_CONTEXT, output: MODEL_OUTPUT }
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
function upstreamMessages(antiBody, apiKey, retried) {
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
        // Transient gateway edge flakes (observed: empty-body 403 on an
        // otherwise healthy request). Retry once after a short delay.
        if ((res.statusCode === 403 || res.statusCode === 429) && !retried) {
          setTimeout(function () {
            upstreamMessages(antiBody, apiKey, true).then(resolve, reject);
          }, 1500);
          return;
        }
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
// ~4 chars per token heuristic plus the measured gateway overhead.
// Used to fail fast with a clear 400 instead of a 120s+ "upstream timeout"
// followed by full-payload retries.
function estimateInputTokens(antiBody) {
  let chars = 0;
  try {
    chars = JSON.stringify(antiBody.messages || []).length
      + JSON.stringify(antiBody.system || "").length
      + JSON.stringify(antiBody.tools || []).length;
  } catch (e) { return MODEL_CONTEXT; }
  return Math.ceil(chars / 4) + MODEL_OVERHEAD;
}
function checkContext(antiBody, maxTokens) {
  const est = estimateInputTokens(antiBody);
  if (est + maxTokens > MODEL_CONTEXT) {
    return "context length exceeded: est. input ~" + est + " tokens + max_tokens "
      + maxTokens + " > model context " + MODEL_CONTEXT
      + " (includes ~" + MODEL_OVERHEAD + " gateway overhead). Shorten the conversation or compact context.";
  }
  return null;
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
// Live streaming passthrough: the gateway 524s non-streaming requests whose
// first byte takes >~100s, so ALL upstream calls go out with stream:true.
function postUpstream(antiBody, apiKey, callback) {
  const out = Object.assign({}, antiBody, { stream: true });
  const payload = JSON.stringify(out);
  const transport = UPSTREAM_PROTO === "http" ? http : https;
  const opts = {
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: UPSTREAM_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Authorization": "Bearer " + apiKey,
      "Accept": "text/event-stream"
    }
  };
  let called = false;
  function done(e, req, res) { if (!called) { called = true; callback(e, req, res); } }
  let req = null;
  try {
    req = transport.request(opts, function (res) { done(null, req, res); });
  } catch (e) { done(e); return null; }
  req.on("error", function (e) { done(e); });
  req.setTimeout(UPSTREAM_TIMEOUT_MS, function () { req.destroy(new Error("upstream timeout")); });
  req.write(payload);
  req.end();
  return req;
}
function readUpstreamError(upRes, callback) {
  const chunks = [];
  upRes.on("data", function (c) { chunks.push(c); });
  upRes.on("end", function () {
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    const msg = (parsed && parsed.error && (parsed.error.message || JSON.stringify(parsed.error))) || raw.slice(0, 500);
    const err = new Error("upstream " + upRes.statusCode + ": " + msg);
    err.status = upRes.statusCode;
    callback(err);
  });
  upRes.on("error", function (e) { callback(e); });
}
function newStreamState(model) {
  return {
    id: nextId("chatcmpl-"), created: Math.floor(Date.now() / 1000), model: model,
    sentRole: false, toolIndex: -1, toolBlock: {}, stopReason: null,
    inputTokens: 0, outputTokens: 0, text: "", tools: []
  };
}
// Sink events: {role} {text} {toolStart:{index,id,name}}
// {toolArgs:{index,partial}} {done} {upstreamError}
// Robust to gateway SSE variants: dispatches on data.type as well as the
// event: line (some gateways omit event: or use CRLF), ignores thinking/
// ping frames without dropping the text frames that follow them.
function translateFrame(st, event, data, sink) {
  if (!data || typeof data !== "object") { return; }
  const t = data.type || "";
  const ev = event === "message" && t ? t : event;
  if (ev === "message_start") {
    const u = data.message && data.message.usage;
    if (u) {
      if (typeof u.input_tokens === "number") { st.inputTokens = u.input_tokens; }
      if (typeof u.output_tokens === "number") { st.outputTokens = u.output_tokens; }
    }
    sink({ role: true });
    return;
  }
  if (ev === "content_block_start") {
    const b = data.content_block || {};
    if (b.type === "tool_use") {
      st.toolIndex++;
      st.toolBlock[data.index] = st.toolIndex;
      st.tools[st.toolIndex] = { id: b.id || nextId("call_"), name: b.name || "unknown", args: "" };
      sink({ toolStart: { index: st.toolIndex, id: st.tools[st.toolIndex].id, name: st.tools[st.toolIndex].name } });
    }
    return;
  }
  if (ev === "content_block_delta") {
    const d = data.delta || {};
    const dtype = d.type || "";
    if ((dtype === "text_delta" || (!dtype && typeof d.text === "string")) && d.text) {
      st.text += d.text; sink({ text: d.text });
    }
    else if (dtype === "input_json_delta" && d.partial_json) {
      const ti = st.toolBlock[data.index];
      if (ti !== undefined && st.tools[ti]) {
        st.tools[ti].args += d.partial_json;
        sink({ toolArgs: { index: ti, partial: d.partial_json } });
      }
    }
    // thinking_delta / signature_delta / citation deltas: intentionally ignored.
    return;
  }
  if (ev === "content_block_stop") { return; }
  if (ev === "message_delta") {
    const d = data.delta || {};
    if (d.stop_reason) { st.stopReason = d.stop_reason; }
    if (data.usage) {
      if (typeof data.usage.output_tokens === "number") { st.outputTokens = data.usage.output_tokens; }
      if (typeof data.usage.input_tokens === "number") { st.inputTokens = data.usage.input_tokens; }
    }
    return;
  }
  if (ev === "message_stop") { sink({ done: true }); return; }
  if (ev === "ping") { return; }
  if (ev === "error" || t === "error") {
    const e = data.error || {};
    sink({ upstreamError: String(e.message || JSON.stringify(e)) });
    return;
  }
}
function pumpSSE(upRes, onFrame, onEnd) {
  let buf = "";
  let finished = false;
  function end(e) { if (!finished) { finished = true; onEnd(e); } }
  function dispatchFrame(frame) {
    const lines = frame.split("\n");
    let event = null;
    const payloads = [];
    for (let line of lines) {
      if (line.charAt(line.length - 1) === "\r") { line = line.slice(0, -1); }
      if (line.indexOf("event:") === 0) { event = line.slice(6).trim(); }
      else if (line.indexOf("data:") === 0) { payloads.push(line.slice(5).trim()); }
      else if (line.indexOf(":") === 0) { /* SSE comment/heartbeat, ignore */ }
    }
    for (const payload of payloads) {
      if (!payload) { continue; }
      if (payload === "[DONE]") { onFrame("done", "[DONE]"); }
      else {
        try { onFrame(event || "message", JSON.parse(payload)); }
        catch (e) { /* corrupt frame, skip */ }
      }
    }
  }
  upRes.on("data", function (c) {
    buf += c.toString("utf8").replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      dispatchFrame(frame);
    }
  });
  upRes.on("end", function () {
    const tail = buf.trim();
    if (tail) { dispatchFrame(tail); buf = ""; }
    end(null);
  });
  upRes.on("error", function (e) { end(e); });
}
function anthropicFinish(st) {
  if (st.toolIndex >= 0) { return "tool_calls"; }
  return anthropicStopToOpenAI(st.stopReason);
}
function pipeStreamToClient(upReq, upRes, clientRes, model) {
  setCors(clientRes);
  clientRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const st = newStreamState(model);
  let ended = false;
  function emit(delta, finishReason) {
    if (ended) { return; }
    clientRes.write("data: " + JSON.stringify({
      id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model,
      choices: [{ index: 0, delta: delta, finish_reason: finishReason || null }]
    }) + "\n\n");
  }
  function ensureRole() { if (!st.sentRole) { st.sentRole = true; emit({ role: "assistant" }, null); } }
  function finish(reason) {
    if (ended) { return; }
    ensureRole();
    ended = true;
    try {
      clientRes.write("data: " + JSON.stringify({
        id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model,
        choices: [{ index: 0, delta: {}, finish_reason: reason || null }]
      }) + "\n\n");
      clientRes.write("data: [DONE]\n\n");
    } catch (e) {}
    try { clientRes.end(); } catch (e) {}
  }
  clientRes.on("close", function () { ended = true; try { upReq.destroy(); } catch (e) {} });
  pumpSSE(upRes, function (event, data) {
    if (ended) { return; }
    if (event === "done") { finish(anthropicFinish(st)); return; }
    translateFrame(st, event, data, function (ev) {
      if (ended) { return; }
      if (ev.role) { ensureRole(); }
      else if (ev.text !== undefined) { ensureRole(); emit({ content: ev.text }, null); }
      else if (ev.toolStart) { ensureRole(); emit({ tool_calls: [{ index: ev.toolStart.index, id: ev.toolStart.id, type: "function", function: { name: ev.toolStart.name, arguments: "" } }] }, null); }
      else if (ev.toolArgs) { emit({ tool_calls: [{ index: ev.toolArgs.index, function: { arguments: ev.toolArgs.partial } }] }, null); }
      else if (ev.done) { finish(anthropicFinish(st)); }
      else if (ev.upstreamError) { ensureRole(); emit({ content: "upstream stream error: " + ev.upstreamError }, null); finish("stop"); }
    });
  }, function (err) {
    if (ended) { return; }
    if (err) { ensureRole(); emit({ content: "upstream stream error: " + String((err && err.message) || err) }, null); }
    else if (!st.text && st.toolIndex < 0) {
      ensureRole();
      emit({ content: "upstream returned empty completion (0 text frames parsed; stop=" + String(st.stopReason) + ")" }, null);
    }
    finish(anthropicFinish(st));
  });
}
function synthesisToCompletion(st, model) {
  const blocks = [];
  if (st.text) { blocks.push({ type: "text", text: st.text }); }
  for (const t of st.tools) {
    let input = {};
    try { input = t.args ? JSON.parse(t.args) : {}; }
    catch (e) { input = { raw: t.args }; }
    blocks.push({ type: "tool_use", id: t.id, name: t.name, input: input });
  }
  return anthropicToOpenAIResponse({
    content: blocks,
    stop_reason: st.stopReason || (st.toolIndex >= 0 ? "tool_use" : "end_turn"),
    usage: { input_tokens: st.inputTokens, output_tokens: st.outputTokens }
  }, model);
}
function bufferStreamToCompletion(upReq, upRes, clientRes, model) {
  const st = newStreamState(model);
  let called = false;
  function done(e, completion) {
    if (called) { return; }
    called = true;
    if (e) { sendJson(clientRes, 502, { error: { message: String((e && e.message) || e), type: "upstream_error" } }); return; }
    const msg = completion && completion.choices && completion.choices[0] && completion.choices[0].message;
    if ((!msg || !msg.content) && !(msg && msg.tool_calls)) {
      sendJson(clientRes, 502, { error: { message: "upstream returned empty completion (0 text frames parsed; stop=" + String(st.stopReason) + ")", type: "upstream_error" } });
      return;
    }
    sendJson(clientRes, 200, completion);
  }
  clientRes.on("close", function () { called = true; try { upReq.destroy(); } catch (e) {} });
  pumpSSE(upRes, function (event, data) {
    if (called) { return; }
    if (event === "done") { done(null, synthesisToCompletion(st, model)); return; }
    translateFrame(st, event, data, function (ev) {
      if (called) { return; }
      if (ev.done) { done(null, synthesisToCompletion(st, model)); }
      else if (ev.upstreamError) { done(new Error("upstream stream error: " + ev.upstreamError)); }
    });
  }, function (err) {
    if (called) { return; }
    if (err) { done(err); return; }
    if (st.text || st.toolIndex >= 0) { done(null, synthesisToCompletion(st, model)); }
    else { done(new Error("upstream closed stream with no content")); }
  });
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
  const model = oa.model || "claude-opus-4-8";
  const conv = openaiMessagesToAnthropic(oa.messages);
  const antiBody = { model: model, max_tokens: pickMaxTokens(oa), messages: conv.messages };
  if (conv.system) { antiBody.system = conv.system; }
  const tools = convertToolsToAnthropic(oa.tools);
  if (tools) { antiBody.tools = tools; }
  const toolChoice = convertToolChoiceToAnthropic(oa.tool_choice);
  if (toolChoice) { antiBody.tool_choice = toolChoice; }
  if (typeof oa.temperature === "number") { antiBody.temperature = oa.temperature; }
  if (typeof oa.top_p === "number") { antiBody.top_p = oa.top_p; }
  const over = checkContext(antiBody, antiBody.max_tokens);
  if (over) {
    sendJson(res, 400, { error: { message: over, type: "context_length_exceeded" } });
    return;
  }
  function upstreamFailed(e) {
    const code = e && e.status === 401 ? 401 : 502;
    sendJson(res, code, { error: { message: String((e && e.message) || e), type: "upstream_error" } });
  }
  function callUpstream() {
    return new Promise(function (resolve) {
      const upReq = postUpstream(antiBody, apiKey, function (e, req, upRes) {
        if (e) { upstreamFailed(e); resolve(null); return; }
        if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
          readUpstreamError(upRes, function (err) { upstreamFailed(err); resolve(null); });
          return;
        }
        resolve({ upReq: req, upRes: upRes });
      });
      void upReq;
    });
  }
  if (oa.stream) {
    const live = await callUpstream();
    if (live) { pipeStreamToClient(live.upReq, live.upRes, res, model); }
    return;
  }
  const buffered = await callUpstream();
  if (buffered) { bufferStreamToCompletion(buffered.upReq, buffered.upRes, res, model); }
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
  const model = oa.model || "claude-opus-4-8";
  const prompt = oa.prompt || "";
  const suffix = oa.suffix || "";
  const full = suffix ? (String(prompt) + String(suffix)) : String(prompt);
  const antiBody = { model: model, max_tokens: pickMaxTokens(oa), messages: [{ role: "user", content: full || "complete the code" }] };
  if (typeof oa.temperature === "number") { antiBody.temperature = oa.temperature; }
  const overLegacy = checkContext(antiBody, antiBody.max_tokens);
  if (overLegacy) {
    sendJson(res, 400, { error: { message: overLegacy, type: "context_length_exceeded" } });
    return;
  }
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
  // Advertise effective usable context (raw window minus gateway overhead)
  // so clients plan compaction against what really fits.
  const data = MODELS.map(function (m) {
    return { id: m.id, object: "model", created: 1789135475, owned_by: "justworker", context_window: Math.max(0, m.context - MODEL_OVERHEAD), max_output_tokens: m.output };
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

