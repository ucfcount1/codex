const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { createParser } = require("eventsource-parser");

const BASE_V1 = "https://chat.qwen.ai/api/v1";
const BASE_V2 = "https://chat.qwen.ai/api/v2";
const TOKEN_FILE = path.join(__dirname, "token.json");

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

// ===== Send message and stream response =====
async function sendMessage(token, chatId, message) {
  console.log("\n💬 Sending message:", message);

  const body = {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: "qwen3-coder-plus",
    messages: [
      {
        role: "user",
        content: message,
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

  console.log("📡 Streaming response (waiting for chunks...)");

  let receivedAny = false;
  const parser = createParser({
    onEvent(event) {
      if (event.data) {
        try {
          const json = JSON.parse(event.data);
          if (json.choices && json.choices[0].delta?.content) {
            receivedAny = true;
            process.stdout.write(json.choices[0].delta.content);
          }
        } catch {
          // debug log if needed
        }
      }
    },
  });

  res.data.on("data", (chunk) => parser.feed(chunk.toString("utf8")));

  return new Promise((resolve) => {
    res.data.on("end", () => {
      if (!receivedAny) {
        console.log("⚠️ No assistant content received from stream.");
      }
      console.log("\n--- ✅ Stream finished ---");
      resolve();
    });
  });
}

// ===== Main flow =====
(async () => {
  try {
    const token = await loginWithCache("ucfcount2@gmail.com", "120youssef");
    const chatId = await startNewChat(token);

    // First request: addition function
    await sendMessage(
      token,
      chatId,
      "return nodejs addition function who take 2 input",
    );

    // Second request in the SAME chat: multiplication function
    await sendMessage(
      token,
      chatId,
      "return me another function for multiplication",
    );
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
  }
})();
