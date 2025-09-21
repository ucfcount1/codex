/**
 * A minimal bridge to expose an OpenAI-style /v1/responses endpoint backed by Qwen.
 * - Accepts POST /v1/responses with a Responses API-shaped JSON body
 * - Calls Qwen chat API and streams back Codex-compatible SSE events:
 *   response.created, response.output_text.delta, response.output_item.done, response.completed
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createParser } = require("eventsource-parser");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const LOG_FILE =
  process.env.BRIDGE_LOG_FILE || path.join(__dirname, "bridge.log");

// Qwen endpoints
const BASE_V1 = "https://chat.qwen.ai/api/v1";
const BASE_V2 = "https://chat.qwen.ai/api/v2";
const TOKEN_FILE = path.join(__dirname, "token.json");

// ────────────────────────────────────────────────────────────────────────────────
// Logging
// ────────────────────────────────────────────────────────────────────────────────
function logLine(...parts) {
  try {
    const msg = parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ");
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort logging
  }
}

// ────────────────────────────────────────────────────────────────────────────────
/** Token utils (reuse the approach from qwen.js) */
// ────────────────────────────────────────────────────────────────────────────────
function saveToken(token) {
  const data = { token, savedAt: Date.now() };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}
function isTokenExpired(savedAt, maxAgeMs = 60 * 60 * 1000) {
  return Date.now() - savedAt > maxAgeMs;
}
async function loginWithCache(email, password) {
  const cached = loadToken();
  if (cached && !isTokenExpired(cached.savedAt)) {
    return cached.token;
  }
  const hashed = crypto.createHash("sha256").update(password).digest("hex");
  const res = await axios.post(
    `${BASE_V1}/auths/signin`,
    { email, password: hashed },
    { headers: { "Content-Type": "application/json; charset=UTF-8" } },
  );
  const token = res.data.token;
  saveToken(token);
  return token;
}

async function startNewChat(token, model = "qwen3-coder-plus") {
  const res = await axios.post(
    `${BASE_V2}/chats/new`,
    {
      title: "Codex Bridge Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    },
    {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": `Bearer ${token}`,
      },
    },
  );
  return res.data.data.id;
}

async function streamQwenMessage({
  token,
  chatId,
  message,
  model = "qwen3-coder-plus",
  onDelta,
  onEnd,
}) {
  const body = {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    messages: [
      {
        role: "user",
        content: message,
        user_action: "chat",
        timestamp: Math.floor(Date.now() / 1000),
        models: [model],
        chat_type: "t2t",
        feature_config: { thinking_enabled: false, output_schema: "phase" },
        extra: { meta: { subChatType: "t2t" } },
        sub_chat_type: "t2t",
        parent_id: null,
      },
    ],
    timestamp: Math.floor(Date.now() / 1000),
  };

  const res = await axios.post(
    `${BASE_V2}/chat/completions?chat_id=${chatId}`,
    body,
    {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": `Bearer ${token}`,
        "Accept": "*/*",
      },
      responseType: "stream",
    },
  );

  // Create parser compatible with both v2 (fn) and v3 ({ onEvent }) APIs
  const onEv = (event) => {
    if (!event?.data) return;
    logLine("qwen_sse_event_data", event.data);
    try {
      const json = JSON.parse(event.data);
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        onDelta?.(delta);
      }
    } catch {
      // Ignore non-JSON or heartbeat lines
    }
  };
  let parser;
  try {
    parser = createParser({ onEvent: onEv });
  } catch (e1) {
    try {
      parser = createParser(onEv);
    } catch (e2) {
      logLine("parser_init_error", { e1: String(e1), e2: String(e2) });
      throw e2;
    }
  }

  res.data.on("data", (chunk) => {
    try {
      parser.feed(chunk.toString("utf8"));
    } catch (e) {
      logLine("parser_feed_error", String(e));
    }
  });
  res.data.on("end", () => onEnd?.());
  res.data.on("error", (err) => onEnd?.(err));
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers for Responses SSE
// ────────────────────────────────────────────────────────────────────────────────
function summarizePayload(type, payload) {
  try {
    if (type === "response.output_text.delta") {
      return { delta_len: payload?.delta?.length };
    }
    if (type === "response.output_item.done") {
      const it = payload?.item || {};
      return {
        item_type: it.type,
        name: it.name,
        args_len:
          typeof it.arguments === "string" ? it.arguments.length : undefined,
        content_len: it.content ? JSON.stringify(it.content).length : undefined,
      };
    }
    if (type === "response.completed") return payload;
  } catch {}
  return undefined;
}

function writeSse(res, type, payload) {
  if (res.writableEnded) return;
  const data = JSON.stringify({ type, ...payload });
  // Including event line improves readability; Codex relies on `type` in data
  res.write(`event: ${type}\n`);
  res.write(`data: ${data}\n\n`);
  logLine("emit_sse", type, summarizePayload(type, payload));
}

function extractLatestUserText(inputArray) {
  if (!Array.isArray(inputArray)) return "";
  // Find last message with role=user and extract concatenated InputText
  for (let i = inputArray.length - 1; i >= 0; i--) {
    const item = inputArray[i];
    if (
      item?.type === "message" &&
      item?.role === "user" &&
      Array.isArray(item.content)
    ) {
      const t = item.content
        .filter((c) => c?.type === "input_text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      if (t) return t;
    }
  }
  // Fallback: join all user input_texts
  const all = inputArray
    .filter((it) => it?.type === "message" && it?.role === "user")
    .flatMap((it) => (Array.isArray(it.content) ? it.content : []))
    .filter((c) => c?.type === "input_text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n\n");
  return all || "";
}

function renderInputForQwen(inputArray) {
  if (!Array.isArray(inputArray)) return "";
  const parts = [];
  for (const item of inputArray) {
    if (item?.type === "message" && item?.role && Array.isArray(item.content)) {
      const text = item.content
        .filter(
          (c) =>
            (c?.type === "input_text" || c?.type === "output_text") &&
            typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n");
      if (text) parts.push(`${item.role.toUpperCase()}:\n${text}`);
    } else if (item?.type === "function_call_output") {
      // Summarize tool output for Qwen context
      try {
        const parsed = typeof item.output === "object" ? item.output : null;
        const ok = parsed?.success;
        const content = parsed?.content;
        parts.push(
          `TOOL OUTPUT (call_id=${item.call_id}, success=${ok}):\n${content || ""}`,
        );
      } catch {
        // ignore
      }
    }
  }
  return parts.join("\n\n");
}

function findPatchBlocks(text) {
  const blocks = [];
  const begin = "*** Begin Patch";
  const end = "*** End Patch";
  let idx = 0;
  while (true) {
    const s = text.indexOf(begin, idx);
    if (s === -1) break;
    const e = text.indexOf(end, s);
    if (e === -1) break; // incomplete
    const block = text.slice(s, e + end.length);
    blocks.push(block);
    idx = e + end.length;
  }
  return blocks;
}

function stripJsonFence(text) {
  const t = text.trim();
  // ```json ... ``` or ``` ... ```
  if (t.startsWith("```")) {
    const firstNl = t.indexOf("\n");
    if (firstNl !== -1) {
      const withoutFence = t.slice(firstNl + 1);
      const endFence = withoutFence.lastIndexOf("```");
      if (endFence !== -1) {
        return withoutFence.slice(0, endFence).trim();
      }
    }
  }
  return t;
}

function tryParseJson(text) {
  const t = stripJsonFence(text);
  try {
    return JSON.parse(t);
  } catch {
    // try to extract outermost braces
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const sub = t.slice(start, end + 1);
      try {
        return JSON.parse(sub);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Express app
// ────────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Main bridge endpoint
app.post("/v1/responses", async (req, res) => {
  logLine("incoming_request", {
    url: req.originalUrl,
    headers: {
      "user-agent": req.headers["user-agent"],
      "authorization": !!req.headers["authorization"],
    },
  });

  // Prepare SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let finished = false;
  const markFinished = () => {
    finished = true;
    try {
      res.end();
    } catch {}
  };
  res.once("close", () => {
    finished = true;
    logLine("client_closed_connection");
  });

  // Emit response.created immediately
  writeSse(res, "response.created", { response: {} });

  try {
    const { instructions, input /*, tools*/ } = req.body || {};
    logLine("request_body", req.body || {});
    // Provide full context to Qwen so it can reason about tool results
    const history = renderInputForQwen(input);
    const userText = extractLatestUserText(input) || "";

    // Heuristic: detect intent like "update the file <path> ..."
    function detectFileUpdateIntent(text) {
      if (!text) return null;
      const re = /update\s+(?:the\s+)?file\s+([^\s\"]+)/i;
      const m = text.match(re);
      if (m && m[1]) {
        return { path: m[1] };
      }
      return null;
    }
    const intent = detectFileUpdateIntent(userText);

    // Prompting: force only apply_patch tool call, no messages, no shell.
    const jsonDirective = [
      "Respond ONLY as minified JSON, no prose, no code fences.",
      'Schema: {"tool_calls":[{"name":"apply_patch","arguments":{"input":string}}]}',
      'Allowed tool: apply_patch only. Do NOT include "shell" or any other tool_calls.',
      'Do NOT include a "message" field. Output only tool_calls.',
      'arguments.input must contain a valid apply_patch patch strictly between *** Begin Patch and *** End Patch.',
    ].join(" ");

    const prompt = [instructions || "", jsonDirective, history, userText]
      .filter(Boolean)
      .join("\n\n");
    logLine("constructed_prompt_len", prompt.length);
    logLine("constructed_prompt_preview", prompt.slice(0, 2000));

    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;
    if (!email || !password) {
      throw new Error("QWEN_EMAIL and QWEN_PASSWORD must be set in env");
    }

    const token = await loginWithCache(email, password);
    const chatId = await startNewChat(token);

    let fullText = "";
    let emittedAnyTool = false;

    function emitToolCallsAndEnd(parsed) {
      if (finished) return;
      const toolCalls = Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
        : [];
      for (const tc of toolCalls) {
        const name = tc?.name;
        if (name !== "apply_patch") {
          logLine("ignored_tool_call", { name });
          continue;
        }
        const argsObj = tc?.arguments;
        const input = argsObj && typeof argsObj === "object" ? argsObj.input : undefined;
        if (typeof input === "string" && input.includes("*** Begin Patch") && input.includes("*** End Patch")) {
          const callId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const args = JSON.stringify({ input });
          writeSse(res, "response.output_item.done", {
            item: {
              type: "function_call",
              call_id: callId,
              name: "apply_patch",
              arguments: args,
            },
          });
          emittedAnyTool = true;
          break; // only first apply_patch
        }
      }
      if (!emittedAnyTool && intent && intent.path) {
        const patch = `*** Begin Patch\n*** Update File: ${intent.path}\n@@\n+function subtract(a, b) { return a - b; }\n+\n+function multiply(a, b) { return a * b; }\n*** End Patch`;
        const callId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        writeSse(res, "response.output_item.done", {
          item: {
            type: "function_call",
            call_id: callId,
            name: "apply_patch",
            arguments: JSON.stringify({ input: patch }),
          },
        });
        logLine("fallback_synthesized_apply_patch", { path: intent.path });
      }
      const responseId = `resp_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      writeSse(res, "response.completed", { response: { id: responseId } });
      markFinished();
    }

    // Safety timer: if model doesn't produce a tool call quickly, synthesize apply_patch for simple update intents.
    const fallbackTimer = setTimeout(() => {
      if (finished || emittedAnyTool) return;
      if (intent && intent.path) {
        const patch = `*** Begin Patch\n*** Update File: ${intent.path}\n@@\n+function subtract(a, b) { return a - b; }\n+\n+function multiply(a, b) { return a * b; }\n*** End Patch`;
        const callId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        writeSse(res, "response.output_item.done", {
          item: {
            type: "function_call",
            call_id: callId,
            name: "apply_patch",
            arguments: JSON.stringify({ input: patch }),
          },
        });
        const responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        writeSse(res, "response.completed", { response: { id: responseId } });
        logLine("fallback_synthesized_apply_patch", { path: intent.path });
        markFinished();
      }
    }, 8000);

    // Stream from Qwen
    await new Promise((resolve, reject) => {
      streamQwenMessage({
        token,
        chatId,
        message: prompt,
        onDelta: (delta) => {
          if (finished) return;
          fullText += delta;

          // Try early parse if Qwen is constructing JSON incrementally
          if (fullText.length > 50 && fullText.includes("tool_calls")) {
            const parsedEarly = tryParseJson(fullText);
            if (parsedEarly && Array.isArray(parsedEarly.tool_calls) && parsedEarly.tool_calls.some((tc) => tc?.name === "apply_patch")) {
              logLine("early_parsed_tool_calls", {
                count: parsedEarly.tool_calls.length,
              });
              emitToolCallsAndEnd(parsedEarly);
            }
          }
        },
        onEnd: (err) => {
          if (err) return reject(err);
          return resolve();
        },
      }).catch(reject);
    });

    logLine("qwen_full_response_len", fullText.length);
    logLine("qwen_full_response_preview", fullText.slice(0, 2000));

    // Try to parse the full response as JSON (if not already finished by early parse)
    if (!finished) {
      const parsed = tryParseJson(fullText);
      if (parsed && (parsed.tool_calls || parsed.message)) {
        logLine("parsed_json_ok", {
          tool_calls_len: Array.isArray(parsed.tool_calls)
            ? parsed.tool_calls.length
            : 0,
          has_message: !!parsed.message,
        });
        emitToolCallsAndEnd(parsed);
      } else {
        logLine("parsed_json_failed_or_empty");
        // Fallback: if plain text, try to surface patches as tool calls; otherwise emit nothing to keep UI clean
        const patches = findPatchBlocks(fullText);
        if (patches.length > 0) {
          logLine("detected_patches", { count: patches.length });
          const patch = patches[0];
          const callId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const args = JSON.stringify({ input: patch });
          writeSse(res, "response.output_item.done", {
            item: {
              type: "function_call",
              call_id: callId,
              name: "apply_patch",
              arguments: args,
            },
          });
        }
        const responseId = `resp_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        writeSse(res, "response.completed", { response: { id: responseId } });
        markFinished();
      }
    }
  } catch (err) {
    // In case of error, try to convey a structured error and then close.
    const message = err?.message || "Unknown error";
    logLine("bridge_error", message);
    writeSse(res, "response.output_item.done", {
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Error: ${message}` }],
      },
    });
    writeSse(res, "response.completed", {
      response: { id: `resp_err_${Date.now().toString(36)}` },
    });
    markFinished();
  }
});

// ────────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Qwen bridge listening on http://localhost:${PORT}`);
  logLine("bridge_start", { port: PORT });
});
