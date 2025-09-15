require("dotenv").config();
const express = require("express");
const cors = require("cors");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

function randId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function tryParseJson(textOrObj) {
  if (textOrObj && typeof textOrObj === "object") return textOrObj;
  if (typeof textOrObj !== "string") return null;
  try {
    return JSON.parse(textOrObj);
  } catch (_) {}
  // fenced code block support
  const fence = /```\s*json\s*([\s\S]*?)```/i.exec(textOrObj);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch (_) {}
  }
  // best-effort slice between first { and last }
  const a = textOrObj.indexOf("{");
  const b = textOrObj.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) {
    try {
      return JSON.parse(textOrObj.slice(a, b + 1));
    } catch (_) {}
  }
  return null;
}

function mapJsonToSse(res, obj) {
  // reasoning.summary → reasoning_summary_text.delta
  const summary = obj?.reasoning?.summary;
  if (typeof summary === "string" && summary.trim()) {
    sse(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      delta: summary.trim(),
    });
  }

  // tool_calls
  const tools = Array.isArray(obj?.tool_calls) ? obj.tool_calls : [];
  for (const tc of tools) {
    if (
      tc?.type === "function" &&
      tc?.name === "shell" &&
      Array.isArray(tc?.arguments?.command)
    ) {
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "local_shell_call",
          call_id: randId("call_shell"),
          status: "in_progress",
          action: {
            type: "exec",
            command: tc.arguments.command,
            timeout_ms: 120000,
          },
        },
      });
      continue;
    }
    if (tc?.type === "function" && tc?.name === "update_plan") {
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "update_plan",
          arguments: JSON.stringify(tc.arguments ?? {}),
          call_id: randId("call_update_plan"),
        },
      });
      continue;
    }
    // fallback: unknown tool → message
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(tc) }],
      },
    });
  }

  // content → assistant message(s)
  const contents = Array.isArray(obj?.content) ? obj.content : [];
  for (const c of contents) {
    if (c?.type === "text" && typeof c?.text === "string") {
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: c.text }],
        },
      });
    }
  }
}

// Plug in your real LLM call here.
// If LLM_URL is set, this forwards the full request body to that URL.
async function askLlm(requestBody, reqHeaders = {}) {
  const url = process.env.LLM_URL;
  if (!url) {
    // Fallback: echo a basic message to demonstrate wiring
    return JSON.stringify({
      content: [
        {
          type: "text",
          text: "LLM_URL not configured – returning placeholder.",
        },
      ],
    });
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...reqHeaders },
      body: JSON.stringify(requestBody ?? {}),
    });
    const text = await resp.text();
    return text;
  } catch (e) {
    return JSON.stringify({
      content: [{ type: "text", text: `LLM error: ${String(e)}` }],
    });
  }
}

// ─────────────────────────────── Routes ───────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Generic Responses adapter: forward to LLM and map JSON → SSE
app.post("/v1/responses", async (req, res) => {
  setupSSE(res);
  const responseId = randId("resp");
  sse(res, "response.created", {
    type: "response.created",
    response: { id: responseId },
  });

  const llmReply = await askLlm(req.body, {
    conversation_id:
      req.headers["conversation_id"] || req.headers["session_id"] || "",
  });
  const obj = tryParseJson(llmReply);

  if (obj) {
    mapJsonToSse(res, obj);
  } else {
    // Fallback: one assistant message with raw text
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: String(llmReply ?? "") }],
      },
    });
  }

  sse(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  res.end();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
