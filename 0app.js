require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");

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
// Track conversation progression: 0 = first, 1 = second, 2+ = subsequent
const convStep = new Map();
try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch (_) {}

// ─────────────────────────────── Helpers ───────────────────────────────
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

// ─────────────────────────────── Routes ───────────────────────────────

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", model: MODEL_ID });
});

// Minimal models
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

// Responses (special behavior for first call only)
// Responses (special behavior for first call only)
// Responses (special behavior for first call only)
app.post("/v1/responses", (req, res) => {
  setupSSE(res);
  const responseId = "resp_" + Math.random().toString(36).slice(2);
  const convId = req.headers["conversation_id"] || req.headers["session_id"] || "global";
  const step = convStep.get(convId) ?? 0;

  // 1) created
  sse(res, "response.created", { type: "response.created", response: { id: responseId } });

  if (step === 0) {
    // First answer: local shell call to inspect test.js
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta:
        "The user wants to update a function in `test.js` to add subtraction functionality. I'll first examine the file to understand its current structure, then make the necessary changes.",
    });
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "local_shell_call",
        call_id: "call_1",
        status: "in_progress",
        action: { type: "exec", command: ["cat", "test.js"], timeout_ms: 120000 },
      },
    });
    convStep.set(convId, 1);
  } else if (step === 1) {
    // Second answer: function_call to update_plan with provided plan JSON
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta:
        "I've examined the test.js file and can see it currently has a sum function that adds two numbers. The user wants to add subtraction functionality. I'll update the function to include subtraction.",
    });
    const planArgs = {
      plan: [
        { step: "Update the sum function to also handle subtraction", status: "in_progress" },
      ],
    };
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "update_plan",
        arguments: JSON.stringify(planArgs),
        call_id: "call_update_plan_1",
      },
    });
    convStep.set(convId, 2);
  } else if (step === 2) {
    // Third answer: shell tool to apply a patch to test.js
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta:
        "I'm updating the test.js file to add subtraction functionality to the existing sum function. I'll modify the function to handle both addition and subtraction operations.",
    });

    const patch = `*** Begin Patch\n*** Update File: test.js\n@@ function sum(a, b) {\n-  return a + b;\n+  // Handle both addition and subtraction\n+  if (b < 0) {\n+    return a + b; // When b is negative, addition becomes subtraction\n+  } else {\n+    return a + b; // Standard addition\n+  }\n+}\n+\n+function subtract(a, b) {\n+  return a - b;\n*** End Patch\n`;

    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "local_shell_call",
        call_id: "call_2",
        status: "in_progress",
        action: { type: "exec", command: ["apply_patch", patch], timeout_ms: 120000 },
      },
    });
    convStep.set(convId, 3);
  } else if (step === 3) {
    // Fourth answer: verify changes by reading the file again
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta:
        "I've updated the test.js file to add subtraction functionality. I added a comment to clarify the sum function behavior and created a new subtract function. Let me verify the changes by reading the file again.",
    });

    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "local_shell_call",
        call_id: "call_3",
        status: "in_progress",
        action: { type: "exec", command: ["cat", "test.js"], timeout_ms: 120000 },
      },
    });
    convStep.set(convId, 4);
  } else if (step === 4) {
    // Fifth answer: mark plan step as completed
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta:
        "I've successfully updated the test.js file. I can see that the sum function now has comments explaining its behavior, and a new subtract function has been added. Let me update the plan to mark this task as complete.",
    });

    const planArgs = {
      plan: [
        { step: "Update the sum function to also handle subtraction", status: "completed" },
      ],
    };
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "update_plan",
        arguments: JSON.stringify(planArgs),
        call_id: "call_update_plan_2",
      },
    });
    convStep.set(convId, 5);
  } else if (step === 5) {
    // Sixth answer: final assistant message confirming completion
    const finalText = "**Task Completed**\n\nI've successfully updated your `test.js` file to add subtraction functionality:\n\n- Modified the `sum` function with comments explaining its behavior\n- Added a new `subtract` function that performs subtraction\n\nThe updated file now includes both functions for addition and subtraction operations. You can test the functions with different values as shown in the existing example usage comments.";
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: finalText }],
      },
    });
    convStep.set(convId, 6);
  } else {
    // Subsequent requests: save and acknowledge
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(`${SAVE_DIR}/request-${ts}-${convId}.json`, JSON.stringify(req.body || {}, null, 2), "utf8");
    } catch (_) {}
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Request saved. No action taken." }] },
    });
  }

  // 3) completed
  sse(res, "response.completed", { type: "response.completed", response: { id: responseId, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  res.end();
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
