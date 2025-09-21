const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { createParser } = require("eventsource-parser");
// --- Import Express ---
const express = require("express");

const BASE_V1 = "https://chat.qwen.ai/api/v1";
const BASE_V2 = "https://chat.qwen.ai/api/v2";
const TOKEN_FILE = path.join(__dirname, "token.json");

let chatId = null;

// ===== Token Utilities =====
function saveToken(token) {
  const data = { token, savedAt: Date.now() };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  console.log(
    "💾 Token saved locally at",
    new Date(data.savedAt).toISOString(),
  );
}
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.log("📂 No token file found, will login.");
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    console.log(
      "📂 Found cached token, saved at",
      new Date(data.savedAt).toISOString(),
    );
    return data;
  } catch {
    console.log("⚠️ Failed to read token file, will login.");
    return null;
  }
}
function isTokenExpired(savedAt, maxAgeMs = 60 * 60 * 1000) {
  const expired = Date.now() - savedAt > maxAgeMs;
  console.log(
    expired ? "⏰ Cached token expired." : "⏳ Cached token still valid.",
  );
  return expired;
}
async function loginWithCache(email, password) {
  const cached = loadToken();
  if (cached && !isTokenExpired(cached.savedAt)) {
    console.log("✅ Using cached token");
    return cached.token;
  }

  console.log("🔑 Cached token missing/expired, logging in...");
  const hashed = crypto.createHash("sha256").update(password).digest("hex");

  const res = await axios.post(
    `${BASE_V1}/auths/signin`,
    { email, password: hashed },
    { headers: { "Content-Type": "application/json; charset=UTF-8" } },
  );

  const token = res.data.token;
  console.log("✅ Login success, new token:", token.slice(0, 25) + "...");
  saveToken(token);
  return token;
}

// ===== Chat creation =====
async function startNewChat(token) {
  console.log("📝 Starting a new chat...");

  const res = await axios.post(
    `${BASE_V2}/chats/new`,
    {
      title: "New Chat",
      models: ["qwen3-coder-plus"],
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
  const chatId = res.data.data.id;
  console.log("✅ Chat created with ID:", chatId);
  return chatId;
}

// ===== Send message and collect full response =====
// --- Modified sendMessage to accept any string as message ---
async function sendMessage(message) {
  console.log("\n💬 Sending message:", message);
  const token = await loginWithCache("ucfcount2@gmail.com", "120youssef"); // Consider making these configurable
  if (chatId == null) chatId = await startNewChat(token);

  const body = {
    stream: true, // Keep stream true for the Qwen API interaction
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: "qwen3-coder-plus",
    messages: [
      {
        role: "user",
        content: message, // Send the provided message string
        user_action: "chat",
        timestamp: Math.floor(Date.now() / 1000),
        models: ["qwen3-coder-plus"],
        chat_type: "t2t",
        feature_config: { thinking_enabled: false, output_schema: "phase" },
        extra: { meta: { subChatType: "t2t" } },
        sub_chat_type: "t2t",
        parent_id: null,
      },
    ],
    timestamp: Math.floor(Date.now() / 1000),
  };

  const response = await axios.post(
    `${BASE_V2}/chat/completions?chat_id=${chatId}`,
    body,
    {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": `Bearer ${token}`,
        "Accept": "text/event-stream", // Indicate we expect an SSE stream
      },
      responseType: "stream",
    },
  );

  console.log("📡 Collecting response from stream...");

  let fullResponse = ""; // Variable to accumulate the response
  let receivedAny = false;

  const parser = createParser({
    onEvent(event) {
      if (event.data === "[DONE]") {
        // Optionally handle the end signal from the server if sent
        return;
      }
      if (event.data) {
        try {
          const json = JSON.parse(event.data);
          if (json.choices && json.choices[0].delta?.content) {
            receivedAny = true;
            const content = json.choices[0].delta.content;
            // --- Accumulate the content ---
            fullResponse += content;
            // Optional: Log to server console as it arrives (remove if too verbose)
            // process.stdout.write(content);
          }
        } catch (e) {
          // Log parsing errors if needed
          console.error("Error parsing SSE event:", e.message);
        }
      }
    },
  });

  // Return a Promise that resolves when the stream is done
  return new Promise((resolve, reject) => {
    // Pipe the raw data stream from the Qwen API to the parser
    response.data.on("data", (chunk) => {
      parser.feed(chunk.toString("utf8"));
    });

    // Handle the end of the stream from the Qwen API
    response.data.on("end", () => {
      if (!receivedAny) {
        console.log("⚠️ No assistant content received from stream.");
        // Resolve with a message indicating no content
        resolve("⚠️ No response generated by Qwen.");
      } else {
        console.log("\n--- ✅ Full stream received ---");
        // Resolve with the accumulated full response
        resolve(fullResponse.trim()); // Trim any leading/trailing whitespace
      }
    });

    // Handle potential errors from the Qwen API stream
    response.data.on("error", (err) => {
      console.error("Error in Qwen API stream:", err);
      reject(new Error("Error receiving response from Qwen API."));
    });
  });
}

// --- Server Setup ---
const app = express();
const PORT = 4000;

// Middleware to parse JSON bodies
// Increased limit if you expect large bodies
app.use(express.json({ limit: "10mb" }));

// POST endpoint for /chat - Accepts any JSON body
app.post("/chat", async (req, res) => {
  // --- Use the entire req.body as the message ---
  // Convert the JSON object to a string to send as the message content
  const userMessage = JSON.stringify(req.body);

  try {
    console.log(`[Server] Received body for chat: ${userMessage}`);
    // --- Await the full response from sendMessage ---
    const qwenResponse = await sendMessage(userMessage);

    // --- Send the complete response back to the client as JSON ---
    res.status(200).json({ response: qwenResponse });
  } catch (error) {
    console.error("Error processing message:", error);
    // Send a generic error message to the client
    res
      .status(500)
      .json({ error: "Internal Server Error while communicating with Qwen." });
  }
});

// Start the server
app.listen(PORT, "0.0.0.0", () => {
  // Listen on all interfaces
  console.log(`🚀 Server is running on http://0.0.0.0:${PORT}`);
  console.log(`📡 POST endpoint available at http://0.0.0.0:${PORT}/chat`);
  console.log(`   Send any JSON object in the POST body.`);
});
