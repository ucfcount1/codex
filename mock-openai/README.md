Local OpenAI proxy (SSE) and Qwen adapter

Overview
- `qwen.js` connects to Qwen’s hosted API, maintains a chat, and exposes `POST /chat` on port 4000 returning `{ response: string }`.
- `openai-proxy.js` mimics OpenAI’s Responses API and streams SSE on `POST /v1/responses` (port 3000). It forwards Codex’s JSON body to `http://127.0.0.1:4000/chat` and converts the final text into `response.output_text.delta`, `response.output_item.done`, and `response.completed` events.

Install
- From this `mock-openai` folder run: `npm install`

Run
- In one terminal: `npm run qwen`  (starts Qwen adapter on :4000)
- In another: `npm run proxy` (starts OpenAI-compatible proxy on :3000)

Point Codex to the proxy
- Set `OPENAI_BASE_URL=http://127.0.0.1:3000/v1` before launching Codex.
- Codex will `POST /v1/responses` and receive SSE events.

Notes
- The proxy sends an immediate `response.created`, then delta chunks, then a final `response.output_item.done` and `response.completed`.
- Errors from the Qwen adapter stream a `response.failed` followed by `response.completed`.
