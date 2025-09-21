const http = require("http");

// Simple SSE helper to write events in the shape Codex expects.
function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function genResponseId() {
  return `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function genCallId() {
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Build a minimal Responses API compatible SSE stream for Codex
async function handleResponses(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Flush an initial created event immediately to let Codex know the stream is live.
  const responseId = genResponseId();
  writeSse(res, "response.created", {
    type: "response.created",
    response: { id: responseId },
  });

  // Optionally coerce JSON-only answers by appending an instruction.
  if (process.env.PROXY_FORCE_JSON === "1" && req.body && typeof req.body.instructions === "string") {
    req.body.instructions = `${req.body.instructions}\n\nWhen responding, output strictly JSON only in a single object. Do not include prose or code fences.`;
  }

  // Forward the full JSON payload to the local qwen adapter,
  // unless MOCK_QWEN is set for local testing without internet.
  let fullText;
  try {
    if (process.env.MOCK_QWEN === "1") {
      fullText = "This is a mocked Qwen response used for local testing without internet.";
    } else {
      fullText = await postJson("127.0.0.1", 4000, "/chat", req.body);
    }
  } catch (err) {
    const message = err?.response?.data?.error || err?.message || "Upstream error";
    writeSse(res, "response.failed", {
      type: "response.failed",
      response: { error: { message } },
    });
    // Complete the stream (Codex will surface the error from response.failed)
    writeSse(res, "response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
        output: [],
      },
    });
    return res.end();
  }

  // Try to map the upstream answer into either a tool call or a message.
  let handled = false;
  let text = String(fullText || "");

  // 1) If instructed, try to parse strict JSON and map accordingly.
  if (process.env.PROXY_EXPECT_JSON === "1") {
    try {
      const obj = JSON.parse(text);
      // Common shapes supported:
      // { type: 'apply_patch', patch: '*** Begin Patch...*** End Patch' }
      // { action: 'apply_patch', patch: '...' }
      // { apply_patch: '...' }
      // { type: 'message', text: '...' } or { text: '...' }
      let patch = null;
      if (obj && typeof obj === "object") {
        if (obj.type === "apply_patch" && typeof obj.patch === "string") {
          patch = obj.patch;
        } else if (obj.action === "apply_patch" && typeof obj.patch === "string") {
          patch = obj.patch;
        } else if (typeof obj.apply_patch === "string") {
          patch = obj.apply_patch;
        }
      }
      if (patch) {
        const callId = genCallId();
        writeSse(res, "response.output_item.done", {
          type: "response.output_item.done",
          item: {
            type: "custom_tool_call",
            name: "apply_patch",
            input: patch,
            call_id: callId,
          },
        });
        handled = true;
      } else {
        const asText = obj && typeof obj.text === "string" ? obj.text : text;
        text = String(asText);
      }
    } catch (_) {
      // Not JSON; fall back to heuristics below.
    }
  }

  // 2) Heuristic: detect a patch block embedded in plain text.
  if (!handled) {
    const match = /\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/.exec(text);
    if (match && match[0]) {
      const patch = match[0];
      const callId = genCallId();
      writeSse(res, "response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: patch,
          call_id: callId,
        },
      });
      handled = true;
    }
  }

  // 3) Default: stream as assistant message with deltas.
  if (!handled) {
    const chunkSize = 400; // reasonable chunk size for deltas
    for (let i = 0; i < text.length; i += chunkSize) {
      const part = text.slice(i, i + chunkSize);
      writeSse(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        delta: part,
      });
    }

    writeSse(res, "response.output_item.done", {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: text,
          },
        ],
      },
    });
  }

  // Terminal completed event (Codex ignores output[] here but expects an id + usage).
  writeSse(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
      output: [],
    },
  });

  res.end();
}

function main() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  const server = http.createServer(async (req, res) => {
    const { method, url, headers } = req;
    if (method === "GET" && url === "/health") {
      const body = JSON.stringify({ ok: true });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
      return;
    }

    if (method === "POST" && url === "/v1/responses") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", async () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          req.body = body;
        } catch (e) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        // Delegate to SSE handler
        await handleResponses(req, res);
      });
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`OpenAI proxy listening on http://0.0.0.0:${port}`);
    console.log("POST /v1/responses (SSE) → forwards to http://127.0.0.1:4000/chat");
  });
}

if (require.main === module) {
  main();
}

// Minimal HTTP JSON POST helper (avoids external deps)
function postJson(host, port, path, jsonBody) {
  const bodyStr = JSON.stringify(jsonBody || {});
  const options = {
    host,
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
      Accept: "application/json",
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (resp) => {
      let raw = "";
      resp.setEncoding("utf8");
      resp.on("data", (chunk) => (raw += chunk));
      resp.on("end", () => {
        try {
          const data = JSON.parse(raw || "{}");
          resolve((data && data.response) || "");
        } catch (e) {
          reject(new Error(`Invalid JSON from upstream: ${e.message}`));
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(5 * 60 * 1000, () => {
      req.destroy(new Error("Upstream timeout"));
    });
    req.write(bodyStr);
    req.end();
  });
}
