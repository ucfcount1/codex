const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Path to your auth.json
const AUTH_FILE_PATH = "/home/ucf/.codex/auth.json";

// Utility to parse JWT payloads
function parseJwtClaims(rawJwt) {
  try {
    const [, payload] = rawJwt.split(".");
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Authentication manager (only loads file)
class CodexAuth {
  constructor() {
    this.auth = null;
  }

  loadFromFile(filePath = AUTH_FILE_PATH) {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf8");
        this.auth = JSON.parse(data);
        console.log("✅ Loaded tokens from", filePath);
        return this.auth;
      } else {
        throw new Error(`Auth file not found: ${filePath}`);
      }
    } catch (err) {
      console.error("❌ Failed to load auth file:", err.message);
      this.auth = null;
    }
  }

  buildAuthHeaders() {
    if (!this.auth?.tokens?.access_token) {
      throw new Error("No access_token found in auth.json");
    }

    const headers = {
      "originator": "codex_cli_js",
      "User-Agent": `codex_cli_js/1.0.0 (${os.platform()}; ${os.arch()}) ${
        process.env.TERM || "terminal"
      }`,
      "Authorization": `Bearer ${this.auth.tokens.access_token}`,
    };

    if (this.auth.tokens.account_id) {
      headers["chatgpt-account-id"] = this.auth.tokens.account_id;
    }

    return headers;
  }
}

// API Client (ChatGPT backend only)
class CodexClient {
  constructor(auth) {
    this.auth = auth;
  }

  async sendMessage(message, model = "gpt-4") {
    const headers = {
      ...this.auth.buildAuthHeaders(),
      "Accept": "text/event-stream",
      "Content-Type": "application/json",
    };

    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    const payload = {
      model,
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "user",
          content: message,
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      conversation_id: conversationId,
      session_id: sessionId,
      include: [
        "response.output_text.delta",
        "response.output_item.done",
        "response.completed",
      ],
    };

    try {
      console.log(`\n🤖 Sending message to ChatGPT Backend (${model})...`);
      console.log(`📝 Message: ${message}\n`);

      const response = await axios.post(
        "https://chatgpt.com/backend-api/codex/responses",
        payload,
        {
          headers,
          responseType: "stream",
          timeout: 30000,
        },
      );

      return this.parseSSEResponse(response);
    } catch (error) {
      console.error("❌ ChatGPT Backend Error:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
      });
      throw error;
    }
  }

  parseSSEResponse(response) {
    let fullResponse = "";

    return new Promise((resolve, reject) => {
      response.data.on("data", (chunk) => {
        const lines = chunk.toString().split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);

            if (data === "[DONE]") {
              resolve(fullResponse);
              return;
            }

            try {
              const parsed = JSON.parse(data);

              if (
                parsed.type === "response.output_text.delta" &&
                parsed.delta
              ) {
                process.stdout.write(parsed.delta);
                fullResponse += parsed.delta;
              }

              if (parsed.type === "response.completed") {
                console.log("\n\n✅ Response completed\n");
                resolve(fullResponse);
              }
            } catch {
              // ignore parse errors for keep-alive lines
            }
          }
        }
      });

      response.data.on("error", reject);
      response.data.on("end", () => {
        if (fullResponse) {
          resolve(fullResponse);
        } else {
          reject(new Error("Stream ended without response"));
        }
      });
    });
  }
}

// Main application
async function main() {
  console.log("🚀 Codex CLI Node.js (No Auth Flow)\n");

  const auth = new CodexAuth();
  auth.loadFromFile(AUTH_FILE_PATH);

  if (!auth.auth) {
    console.error("❌ No auth data found. Exiting.");
    return;
  }

  const client = new CodexClient(auth);

  try {
    const testMessage = "Hello! Can you tell me a short joke?";
    const response = await client.sendMessage(testMessage, "gpt-4");

    console.log("\n📋 Full response received:\n", response);
  } catch (error) {
    console.error("❌ Main Error:", {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
    });
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { CodexAuth, CodexClient, main };
