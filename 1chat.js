require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const receivedRequest = require("./qwen");
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
// ─────────────────────────────── Logs ───────────────────────────────
app.use((req, res, next) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} [${requestId}] ${req.method} ${req.originalUrl}`;

  try {
    fs.appendFileSync("log.txt", logLine + "\n", "utf8");
    if (req.body && Object.keys(req.body).length > 0) {
      fs.appendFileSync("log.txt", JSON.stringify(req.body) + "\n", "utf8");
    }
    fs.appendFileSync("log.txt", "---\n", "utf8");
  } catch (err) {
    console.warn("Failed to write to log.txt:", err.message);
  }
  next();
});

app.use((req, _res, next) => {
  const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl}`;
  console.log(line);
  try {
    fs.appendFileSync("access.log", line + "\n", "utf8");
  } catch (err) {
    console.warn("Failed to write to access.log:", err.message);
  }
  next();
});

// ─────────────────────────────── Config ───────────────────────────────
const PORT = process.env.PORT || 3000;
const MODEL_ID = process.env.MODEL_ID || "fake-llm";
const SAVE_DIR = process.env.SAVE_DIR || "saved_requests";
try {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
} catch (_) {}

// ─────────────────────────────── Helpers ───────────────────────────────
function randId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  if (data !== undefined) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } else {
    res.write("\n");
  }
}

// Fonction principale : JSON → SSE Codex/OpenAI
function sendCodexResponse(res, json, opts = {}) {
  const responseId = opts.responseId || randId("resp");

  // 0) created
  sse(res, "response.created", {
    type: "response.created",
    response: { id: responseId },
  });

  // 1) Reasoning summary
  const summary = json?.reasoning?.summary;
  if (typeof summary === "string" && summary.trim()) {
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta: summary,
    });
  }

  // Detect explicit finalization flags from model JSON
  const isFinal = json?.final === true || json?.done === true || json?.finish === true;

  // 2) Assistant text: json.content / json.output / assistant_message
  const pushAssistantText = (text) => {
    if (!text) return;
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    });
  };

  // If the model explicitly marks this as final, prefer emitting a single assistant message
  if (isFinal) {
    const finalMsg =
      (typeof json.assistant_message === "string" && json.assistant_message) ||
      (typeof json.output === "string" && json.output) ||
      (typeof json.content === "string" && json.content) ||
      (Array.isArray(json?.content) && json.content.find((c) => c?.type === "text" && typeof c.text === "string")?.text) ||
      "Done.";
    pushAssistantText(finalMsg);
  }

  if (!isFinal && typeof json?.content === "string") {
    pushAssistantText(json.content);
  } else if (!isFinal && Array.isArray(json?.content)) {
    for (const c of json.content) {
      if (c?.type === "text" && typeof c?.text === "string") {
        pushAssistantText(c.text);
      }
    }
  }

  if (!isFinal && typeof json?.output === "string") {
    pushAssistantText(json.output);
  } else if (!isFinal && Array.isArray(json?.output)) {
    for (const o of json.output) {
      if (o && o.type === "output_text" && typeof o.text === "string") {
        pushAssistantText(o.text);
      }
    }
  }

  // 3) Tool calls (normalisation arguments)
  const emitToolCall = (nameIn, argsIn) => {
    const name = (nameIn || "unknown_function").toString();
    let args = argsIn;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (_) {}
    }

    // Helper to stringify function_call arguments as required by codex client
    const emitFunctionCall = (toolName, obj) => {
      const callId = randId("call_fn");
      const argsStr = typeof obj === "string" ? obj : JSON.stringify(obj ?? {});
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: toolName,
          arguments: argsStr,
          call_id: callId,
        },
      });
      return true;
    };

    // Map shell-like requests to exec_command tool
    if (["shell", "exec", "bash", "sh", "run"].includes(name)) {
      // Normalize to a single string command
      let cmdStr = undefined;
      if (typeof args?.cmd === "string") {
        cmdStr = args.cmd;
      } else if (Array.isArray(args?.command)) {
        // Simple join; codex tool will run in a shell
        cmdStr = args.command.join(" ");
      } else if (typeof args?.command === "string") {
        cmdStr = args.command;
      } else if (Array.isArray(args)) {
        cmdStr = args.join(" ");
      }
      if (cmdStr) {
        const payload = { cmd: cmdStr };
        if (typeof args?.yield_time_ms === "number") payload.yield_time_ms = args.yield_time_ms;
        if (typeof args?.max_output_tokens === "number") payload.max_output_tokens = args.max_output_tokens;
        if (typeof args?.shell === "string") payload.shell = args.shell;
        if (typeof args?.login === "boolean") payload.login = args.login;
        return emitFunctionCall("exec_command", payload);
      }
    }

    // Map apply_patch to a custom tool call that Codex always supports
    if (name === "apply_patch") {
      // Accept either {patch: "*** Begin Patch..."} or raw string with patch
      let patchText = undefined;
      if (typeof args?.input === "string") patchText = args.input;
      else if (typeof args?.patch === "string") patchText = args.patch;
      else if (typeof args === "string") patchText = args;
      if (patchText) {
        const callId = randId("call_apply_patch");
        sse(res, "response.output_item.done", {
          type: "response.output_item.done",
          item: {
            type: "custom_tool_call",
            name: "apply_patch",
            input: patchText,
            call_id: callId,
          },
        });
        return true;
      }
    }

    // Generic function/tool call passthrough
    return emitFunctionCall(name, args ?? {});
  };

  const tools = Array.isArray(json?.tool_calls) ? json.tool_calls : [];
  if (!isFinal && tools.length > 0) {
    for (const call of tools) {
      const name = call?.type || call?.name || call?.tool || call?.function;
      const args = call?.arguments ?? call?.parameters ?? call?.params ?? call?.args;
      emitToolCall(name, args);
    }
  } else if (!isFinal && json && (json.type || json.name || json.tool || json.function)) {
    // Support simple root-level function/tool call objects
    const name = json.type || json.name || json.tool || json.function;
    const args = json.arguments ?? json.parameters ?? json.params ?? json.args;
    emitToolCall(name, args);
  }

  // 4) completed
  sse(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });

  res.end();
}

// ─────────────────────────────── Routes ───────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", model: MODEL_ID });
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: MODEL_ID,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "local",
      },
    ],
  });
});

app.post("/v1/responses", async (req, res) => {
  setupSSE(res);
  try {
    let answer = await receivedRequest(req.body); // <- déjà objet
    console.log(answer, "-__-----------answer");

    sendCodexResponse(res, answer); // <- direct, pas besoin de parse ici
  } catch (err) {
    console.error("Error in sendCodexResponse:", err);
    sse(res, "error", { error: err.message });
    res.end();
  }
});

// ─────────────────────────────── Start ───────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Fake LLM server running at http://localhost:${PORT}`);
});

server.on("error", (err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});
