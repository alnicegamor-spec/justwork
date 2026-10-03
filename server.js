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
const DEBUG_SSE = process.env.DEBUG_SSE === "1";
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
function imagePartFromUrl(url) {
  if (typeof url !== "string" || !url) { return null; }
  if (url.indexOf("data:image/") === 0) {
    const comma = url.indexOf(",");
    const header = url.slice(0, comma);
    const b64 = url.slice(comma + 1);
    if (!b64) { return null; }
    const m = header.match(/data:image\/([a-zA-Z0-9.+-]+)/);
    const mime = m ? ("image/" + m[1].toLowerCase()) : "image/jpeg";
    return { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
  }
  if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0) {
    return { type: "image", source: { type: "url", url: url } };
  }
  return null;
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
      const part = imagePartFromUrl(block.image_url.url);
      if (part) { parts.push(part); }
    } else if (block.type === "input_image" && block.image_url) {
      const raw = typeof block.image_url === "string" ? block.image_url : block.image_url.url;
      const part = imagePartFromUrl(raw);
      if (part) { parts.push(part); }
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
function fetchImageAsBase64(url, redirects) {
  return new Promise(function (resolve, reject) {
    if (redirects === undefined) { redirects = 3; }
    const transport = url.indexOf("http://") === 0 ? http : https;
    let req = null;
    try {
      req = transport.get(url, { timeout: 25000 }, function (upRes) {
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && redirects > 0) {
          upRes.resume();
          fetchImageAsBase64(upRes.headers.location, redirects - 1).then(resolve, reject);
          return;
        }
        if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
          reject(new Error("image fetch HTTP " + upRes.statusCode));
          upRes.resume();
          return;
        }
        const chunks = [];
        let size = 0;
        upRes.on("data", function (c) {
          size += c.length;
          if (size > 8388608) { reject(new Error("image larger than 8MB")); try { req.destroy(); } catch (e) {} return; }
          chunks.push(c);
        });
        upRes.on("end", function () {
          const buf = Buffer.concat(chunks);
          if (!buf.length) { reject(new Error("image body empty")); return; }
          const ct = String((upRes.headers && upRes.headers["content-type"]) || "image/png").split(";")[0].trim().toLowerCase();
          resolve({ mime: ct.indexOf("image/") === 0 ? ct : "image/png", data: buf.toString("base64") });
        });
        upRes.on("error", reject);
      });
    } catch (e) { reject(e); return; }
    req.on("error", reject);
    req.on("timeout", function () { try { req.destroy(); } catch (e) {} reject(new Error("image fetch timed out")); });
  });
}
async function inlineUrlImages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const content = m && m.content;
    if (!Array.isArray(content)) { continue; }
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      if (b && b.type === "image" && b.source && b.source.type === "url" && b.source.url) {
        const img = await fetchImageAsBase64(b.source.url);
        content[i] = { type: "image", source: { type: "base64", media_type: img.mime, data: img.data } };
      }
    }
  }
}
function estimateInputTokens(antiBody) {
  let chars = 0;
  let images = 0;
  try {
    (function walk(v) {
      if (typeof v === "string") { chars += v.length; return; }
      if (Array.isArray(v)) { for (const x of v) { walk(x); } return; }
      if (v && typeof v === "object") {
        if (v.type === "image" && v.source && v.source.type === "base64" && typeof v.source.data === "string") {
          images++;
          if (typeof v.source.media_type === "string") { chars += v.source.media_type.length; }
          return;
        }
        for (const k of Object.keys(v)) { walk(v[k]); }
      }
    })([antiBody.messages || [], antiBody.system || "", antiBody.tools || []]);
  } catch (e) { return MODEL_CONTEXT; }
  // Anthropic bills images separately (~1-2k tokens each). Raw base64 would
  // otherwise fake ~750k tokens per screenshot and trip the context guard.
  return Math.ceil(chars / 4) + MODEL_OVERHEAD + images * 1600;
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
function pumpSSE(upRes, onFrame, onEnd, collect) {
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
    const s = c.toString("utf8");
    if (collect) {
      collect.frames++;
      if (DEBUG_SSE && collect.raw.length < 2000) { collect.raw += s.slice(0, 2000 - collect.raw.length); }
    }
    buf += s.replace(/\r\n/g, "\n");
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
  const t0 = Date.now();
  const collect = { raw: "", frames: 0 };
  function finishEmptyChecked() {
    if (!st.text && st.toolIndex < 0) {
      ensureRole();
      emit({ content: "upstream returned empty completion (" + collect.frames + " SSE frames, 0 text; stop=" + String(st.stopReason) + ")" }, null);
    }
    finish(anthropicFinish(st));
  }
  function logChat(mode) {
    try {
      console.log("[chat] mode=" + mode + " model=" + model + " textLen=" + st.text.length
        + " tools=" + (st.toolIndex + 1) + " stop=" + String(st.stopReason)
        + " inTok=" + st.inputTokens + " outTok=" + st.outputTokens
        + " frames=" + collect.frames + " ms=" + (Date.now() - t0)
        + (collect.raw ? " sample=" + JSON.stringify(collect.raw.slice(0, 600)) : ""));
    } catch (logE) {}
  }
  clientRes.on("close", function () { ended = true; try { upReq.destroy(); } catch (e) {} });
  pumpSSE(upRes, function (event, data) {
    if (ended) { return; }
    if (event === "done") { logChat("stream"); finishEmptyChecked(); return; }
    translateFrame(st, event, data, function (ev) {
      if (ended) { return; }
      if (ev.role) { ensureRole(); }
      else if (ev.text !== undefined) { ensureRole(); emit({ content: ev.text }, null); }
      else if (ev.toolStart) { ensureRole(); emit({ tool_calls: [{ index: ev.toolStart.index, id: ev.toolStart.id, type: "function", function: { name: ev.toolStart.name, arguments: "" } }] }, null); }
      else if (ev.toolArgs) { emit({ tool_calls: [{ index: ev.toolArgs.index, function: { arguments: ev.toolArgs.partial } }] }, null); }
      else if (ev.done) { logChat("stream"); finishEmptyChecked(); }
      else if (ev.upstreamError) { logChat("stream-error"); ensureRole(); emit({ content: "upstream stream error: " + ev.upstreamError }, null); finish("stop"); }
    });
  }, function (err) {
    if (ended) { return; }
    if (err) { ensureRole(); emit({ content: "upstream stream error: " + String((err && err.message) || err) }, null); }
    else if (!st.text && st.toolIndex < 0) {
      ensureRole();
      emit({ content: "upstream returned empty completion (" + collect.frames + " SSE frames, 0 text; stop=" + String(st.stopReason) + ")" }, null);
    }
    logChat("stream");
    finish(anthropicFinish(st));
  }, collect);
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
  const t0 = Date.now();
  const collect = { raw: "", frames: 0 };
  function logChat() {
    try {
      console.log("[chat] mode=buffered model=" + model + " textLen=" + st.text.length
        + " tools=" + (st.toolIndex + 1) + " stop=" + String(st.stopReason)
        + " inTok=" + st.inputTokens + " outTok=" + st.outputTokens
        + " frames=" + collect.frames + " ms=" + (Date.now() - t0)
        + (collect.raw ? " sample=" + JSON.stringify(collect.raw.slice(0, 600)) : ""));
    } catch (logE) {}
  }
  function done(e, completion) {
    if (called) { return; }
    called = true;
    if (e) { logChat(); sendJson(clientRes, 502, { error: { message: String((e && e.message) || e), type: "upstream_error" } }); return; }
    const msg = completion && completion.choices && completion.choices[0] && completion.choices[0].message;
    if ((!msg || !msg.content) && !(msg && msg.tool_calls)) {
      logChat();
      sendJson(clientRes, 502, { error: { message: "upstream returned empty completion (0 text frames parsed; stop=" + String(st.stopReason) + ")", type: "upstream_error" } });
      return;
    }
    logChat();
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
    else { done(new Error("upstream closed stream with no content (" + collect.frames + " SSE frames)")); }
  }, collect);
}
function pickMaxTokens(oa) {
  const v = oa.max_tokens || oa.max_completion_tokens || 1024;
  const n = parseInt(v, 10);
  if (!n || n < 1) { return 1024; }
  return Math.min(n, 128000);
}
// Be explicit about thinking. Default disabled; enable only when the client
// asks via OpenAI-style reasoning signals, mapped to budgets. (The empty
// turns observed 2026-10-03 come from the gateway's streaming path, not from
// an unset thinking flag: identical bodies return text non-streamed.)
function pickThinking(oa, maxTokens) {
  let effort = null;
  if (oa.reasoning && typeof oa.reasoning.effort === "string") { effort = oa.reasoning.effort; }
  else if (typeof oa.reasoning_effort === "string") { effort = oa.reasoning_effort; }
  else if (oa.reasoning && oa.reasoning.enabled === false) { return { type: "disabled" }; }
  if (!effort) { return { type: "disabled" }; }
  const e = String(effort).toLowerCase();
  let budget = 0;
  if (e === "high" || e === "xhigh") { budget = 10000; }
  else if (e === "medium") { budget = 5000; }
  else if (e === "low" || e === "minimal") { budget = 1024; }
  else { return { type: "disabled" }; }
  if (maxTokens <= budget + 256) { return { type: "disabled" }; }
  return { type: "enabled", budget_tokens: budget };
}
// Collect a streaming upstream attempt without writing to the client, so the
// caller can decide (content vs empty/broken) before delivering anything.
function collectStreamAttempt(antiBody, apiKey) {
  return new Promise(function (resolve, reject) {
    const st = newStreamState(antiBody.model || "probe");
    const collect = { raw: "", frames: 0 };
    let settled = false;
    function settle(v) { if (!settled) { settled = true; resolve(v); } }
    function fail(e) { if (!settled) { settled = true; reject(e); } }
    const upReq = postUpstream(antiBody, apiKey, function (e, req, upRes) {
      if (e) { fail(e); return; }
      if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
        readUpstreamError(upRes, function (err) { fail(err); });
        return;
      }
      pumpSSE(upRes, function (event, data) {
        if (settled) { return; }
        if (event === "done") { settle({ st: st, collect: collect }); return; }
        translateFrame(st, event, data, function (ev) {
          if (settled) { return; }
          if (ev.done) { settle({ st: st, collect: collect }); }
          else if (ev.upstreamError) { fail(new Error("upstream stream error: " + ev.upstreamError)); }
        });
      }, function (err) {
        if (settled) { return; }
        if (err) { fail(err); return; }
        settle({ st: st, collect: collect });
      }, collect);
    });
    void upReq;
  });
}
// Replay a complete OpenAI completion as SSE for stream:true clients.
function sendCompletionAsSSE(res, completion) {
  setCors(res);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const choice = (completion.choices && completion.choices[0]) || {};
  const msg = choice.message || {};
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  function chunk(delta, finish) {
    res.write("data: " + JSON.stringify({
      id: base.id, object: base.object, created: base.created, model: base.model,
      choices: [{ index: 0, delta: delta, finish_reason: finish || null }]
    }) + "\n\n");
  }
  chunk({ role: "assistant" }, null);
  if (typeof msg.content === "string" && msg.content) { chunk({ content: msg.content }, null); }
  const tcs = msg.tool_calls || [];
  for (let i = 0; i < tcs.length; i++) {
    const tc = tcs[i] || {};
    const fn = tc.function || {};
    chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: fn.name || "unknown", arguments: "" } }] }, null);
    chunk({ tool_calls: [{ index: i, function: { arguments: fn.arguments || "" } }] }, null);
  }
  chunk({}, choice.finish_reason || "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}
function imgSummary(messages) {
  let n = 0; let bytes = 0;
  try {
    const list = Array.isArray(messages) ? messages : [];
    for (const m of list) {
      const c = m && m.content;
      if (!Array.isArray(c)) { continue; }
      for (const b of c) {
        if (b && b.type === "image" && b.source) {
          n++;
          if (b.source.type === "base64" && typeof b.source.data === "string") { bytes += b.source.data.length; }
          else if (b.source.type === "url") { bytes += String(b.source.url || "").length; }
        }
      }
    }
  } catch (e) {}
  return n === 0 ? "images=0" : ("images=" + n + "~" + Math.round(bytes / 1024) + "KB");
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
  const thinking = pickThinking(oa, antiBody.max_tokens);
  antiBody.thinking = thinking;
  // Anthropic rejects temperature/top_p alongside enabled thinking.
  if (thinking.type !== "enabled") {
    if (typeof oa.temperature === "number") { antiBody.temperature = oa.temperature; }
    if (typeof oa.top_p === "number") { antiBody.top_p = oa.top_p; }
  }
  try {
    await inlineUrlImages(antiBody.messages);
  } catch (e) {
    sendJson(res, 400, { error: { message: "cannot fetch attached image URL: " + String((e && e.message) || e), type: "invalid_request" } });
    return;
  }
  const over = checkContext(antiBody, antiBody.max_tokens);
  if (over) {
    sendJson(res, 400, { error: { message: over, type: "context_length_exceeded" } });
    return;
  }
  const t0 = Date.now();
  function deliverCompletion(completion) {
    if (oa.stream) { sendCompletionAsSSE(res, completion); return; }
    sendJson(res, 200, completion);
  }
  function upstreamFailed(e) {
    const code = e && e.status === 401 ? 401 : 502;
    sendJson(res, code, { error: { message: String((e && e.message) || e), type: "upstream_error" } });
  }
  // Attempt 1: streaming probe. Fast and Cloudflare-safe, but this gateway
  // currently streams zero content blocks (empty turn, billed tokens).
  // Attempt 2 (fallback): full non-streaming request, which returns text.
  let probe = null;
  let probeErr = null;
  try {
    probe = await collectStreamAttempt(antiBody, apiKey);
  } catch (e) { probeErr = e; }
  if (probe && (probe.st.text || probe.st.toolIndex >= 0)) {
    try {
      console.log("[chat] mode=stream-hit model=" + model + " textLen=" + probe.st.text.length
        + " tools=" + (probe.st.toolIndex + 1) + " frames=" + probe.collect.frames + " ms=" + (Date.now() - t0)
        + " " + imgSummary(antiBody.messages));
    } catch (logE) {}
    deliverCompletion(synthesisToCompletion(probe.st, model));
    return;
  }
  try {
    console.log("[chat] mode=fallback model=" + model
      + " reason=" + (probeErr ? ("streamErr:" + String((probeErr && probeErr.message) || probeErr).slice(0, 120)) : ("empty:" + (probe ? probe.collect.frames : 0) + "frames"))
      + " ms=" + (Date.now() - t0) + " " + imgSummary(antiBody.messages));
  } catch (logE) {}
  let anti = null;
  try {
    anti = await upstreamMessages(antiBody, apiKey);
  } catch (e) { upstreamFailed(e); return; }
  deliverCompletion(anthropicToOpenAIResponse(anti, model));
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
  antiBody.thinking = { type: "disabled" };
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
  sendJson(res, 200, { ok: true, upstream: UPSTREAM_HOST + UPSTREAM_PATH, models: MODELS.map(function (m) { return m.id; }), auth: PROXY_TOKEN ? "token" : "open", version: process.env.RENDER_GIT_COMMIT || "local", time: new Date().toISOString() });
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

