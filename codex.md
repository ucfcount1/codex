# Codex Authentication and Request Spec

This document describes how Codex authenticates with OpenAI and ChatGPT, how it stores tokens, and how it makes API requests (endpoints, headers, and payloads). The second part translates this into a Node.js application specification that reproduces the same flow.

## Part 1 — How Codex Connects (as implemented in this repo)

### Overview
- First run triggers a browser-based OAuth flow with OpenAI Auth using PKCE.
- A tiny local HTTP server listens on `http://localhost:<port>` to receive the OAuth callback.
- Codex exchanges the authorization code for tokens and then exchanges the `id_token` for an API key.
- Credentials are persisted to `~/.codex/auth.json` (no browser cookies are stored by Codex).
- Runtime requests go to either:
  - OpenAI API: `https://api.openai.com/v1/responses` (SSE) or `/v1/chat/completions`, or
  - ChatGPT backend: `https://chatgpt.com/backend-api/codex/...` (when using ChatGPT tokens).

Key code references:
- Login server + PKCE + token exchange: `codex-rs/login/src/server.rs`
- Auth state, refresh, and storage: `codex-rs/core/src/auth.rs`, `codex-rs/core/src/token_data.rs`
- Provider selection, URLs, and default headers: `codex-rs/core/src/model_provider_info.rs`, `codex-rs/core/src/default_client.rs`
- Model requests and SSE handling: `codex-rs/core/src/client.rs`, `codex-rs/core/src/client_common.rs`, `codex-rs/core/src/chat_completions.rs`
- ChatGPT backend GET helper: `codex-rs/chatgpt/src/chatgpt_client.rs`, `codex-rs/chatgpt/src/get_task.rs`

### Browser Login (OAuth + PKCE)
- Issuer: `https://auth.openai.com`
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Local redirect: `http://localhost:<port>/auth/callback` (default port 1455; can be 0 to auto-pick a free port)
- PKCE: S256 challenge; random `state` to prevent CSRF.

Authorize URL format:
```
{issuer}/oauth/authorize?
  response_type=code&
  client_id={CLIENT_ID}&
  redirect_uri={REDIRECT_URI}&
  scope=openid profile email offline_access&
  code_challenge={S256_CODE_CHALLENGE}&
  code_challenge_method=S256&
  id_token_add_organizations=true&
  codex_cli_simplified_flow=true&
  state={STATE}&
  originator=codex_cli_rs
```

Callback handler on `/auth/callback`:
- Validates `state`.
- Exchanges the code for tokens:
  - POST `{issuer}/oauth/token` with `Content-Type: application/x-www-form-urlencoded`
  - Body:
    - `grant_type=authorization_code`
    - `code={code}`
    - `redirect_uri={redirect_uri}`
    - `client_id={client_id}`
    - `code_verifier={pkce_code_verifier}`
- With `id_token` from the above, exchanges for an API key:
  - POST `{issuer}/oauth/token` with `Content-Type: application/x-www-form-urlencoded`
  - Body:
    - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
    - `client_id={client_id}`
    - `requested_token=openai-api-key`
    - `subject_token={id_token}`
    - `subject_token_type=urn:ietf:params:oauth:token-type:id_token`

### Token Storage (`~/.codex/auth.json`)
- Location: `~/.codex/auth.json` (the “Codex home” can be overridden; in this repo it’s resolved by config helpers).
- Format: JSON
- Shape:
```json
{
  "OPENAI_API_KEY": "sk-...",             // may be present if obtained via token exchange or set via login-with-api-key
  "tokens": {
    "id_token": "<raw.jwt.string>",      // stored as raw JWT string
    "access_token": "<opaque-access>",   // OAuth access token
    "refresh_token": "<opaque-refresh>", // OAuth refresh token
    "account_id": "<chatgpt_account_id>" // optional; parsed from JWT claim
  },
  "last_refresh": "2025-01-01T12:34:56Z"  // RFC3339 timestamp when tokens were last refreshed/persisted
}
```
- Notes:
  - The `id_token` is saved as a raw JWT string. When needed, Codex decodes it to read claims from the nested object `https://api.openai.com/auth` (e.g., `chatgpt_account_id`, `chatgpt_plan_type`).
  - The `OPENAI_API_KEY` may be absent if you only did ChatGPT login and the API-key exchange failed; requests that require API keys won’t work until an API key is present or the provider is ChatGPT-based.

### Token Refresh
- Trigger: when `last_refresh` is older than 28 days (or on 401 retries).
- Endpoint: `POST https://auth.openai.com/oauth/token` with JSON body
  ```json
  {
    "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
    "grant_type": "refresh_token",
    "refresh_token": "<refresh-token>",
    "scope": "openid profile email"
  }
  ```
- On success, Codex updates `auth.json` with new `id_token`/`access_token`/`refresh_token` and bumps `last_refresh`.

### Requests to Models
- Default client headers:
  - `originator: codex_cli_rs` (custom header)
  - `User-Agent: codex_cli_rs/<version> (<os>; <arch>) <terminal-info>`
- Provider URL selection (`ModelProviderInfo`):
  - ChatGPT mode (AuthMode::ChatGPT) → base: `https://chatgpt.com/backend-api/codex`
  - API key mode → base: `https://api.openai.com/v1`
  - Path is `/responses` for Responses API or `/chat/completions` for Chat Completions.

Authorization headers:
- OpenAI API: `Authorization: Bearer {OPENAI_API_KEY}`
- ChatGPT backend: `Authorization: Bearer {access_token}` and `chatgpt-account-id: {account_id}`

Responses API (preferred) — request:
- Method: `POST`
- URL: `{base}/v1/responses` or `https://chatgpt.com/backend-api/codex/responses`
- Headers:
  - `Accept: text/event-stream`
  - `OpenAI-Beta: responses=experimental`
  - `conversation_id: {uuid}`
  - `session_id: {uuid}`
  - `Authorization: Bearer ...` (see above)
  - `chatgpt-account-id: ...` (ChatGPT mode only)
- JSON body (key fields):
  - `model: string`
  - `instructions: string` (base + optional extras)
  - `input: ResponseItem[]` (conversation context and tool call anchors)
  - `tools: []` (OpenAI tool definitions)
  - `tool_choice: "auto"`
  - `parallel_tool_calls: false`
  - `reasoning: { effort?, summary? }` (when supported)
  - `store: false` (Azure workaround may set to true)
  - `stream: true`
  - `include: [ ... ]` (SSE event selection)
  - `prompt_cache_key: string` (conversation id)
  - `text: { verbosity? }` (for GPT‑5)

SSE events observed and consumed include (non-exhaustive):
- `response.created`, `response.in_progress`, `response.output_text.delta`,
- `response.output_item.added`, `response.output_item.done`, `response.completed`,
- `response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta`

Chat Completions API (when provider uses it)
- Method: `POST {base}/v1/chat/completions` (SSE)
- Messages array built from conversation items; optional `reasoning` text stitched to adjacent assistant anchors.

### ChatGPT Backend GETs
- Some features fetch task metadata from the ChatGPT backend:
  - `GET https://chatgpt.com/backend-api/wham/tasks/{task_id}`
  - Headers:
    - `Authorization: Bearer {access_token}`
    - `chatgpt-account-id: {account_id}`
    - `Content-Type: application/json`

---

## Part 2 — Node.js Application Spec (replicating the flow)

This section specifies a Node.js implementation to reproduce Codex’s authentication, storage, and request behavior.

### Goals
- Launch browser for ChatGPT/OpenAI login via OAuth (PKCE, state).
- Run a local HTTP server for the callback and finalize token exchanges.
- Persist credentials to `~/.codex/auth.json` in the same JSON format.
- Provide helpers to refresh tokens and to call the OpenAI Responses API (SSE) and select ChatGPT backend GETs.

### Recommended Packages
- HTTP server: `express` or Node `http` module
- Browser open: `open` (cross‑platform) or OS-specific `xdg-open`/`start`/`open`
- HTTP client + SSE: `node-fetch` or `undici` + `eventsource-parser` (or manual stream parsing)
- Crypto for PKCE: Node `crypto` (SHA‑256)

### Configuration and Constants
- Issuer: `https://auth.openai.com`
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Redirect: `http://localhost:{port}/auth/callback` (pick a free port or default to 1455)
- Scopes: `openid profile email offline_access`
- Storage path: `${HOME}/.codex/auth.json` (respect `$CODEX_HOME` if desired)
- Default headers: add `originator: codex_cli_js` and a descriptive `User-Agent`

### PKCE + State Utilities
- Generate `code_verifier`: random URL‑safe string (32–64 bytes before base64url)
- Compute `code_challenge = base64url(sha256(code_verifier))`
- Generate random `state` (e.g., 16–32 bytes base64url)

Example (TypeScript-like pseudocode):
```ts
import { createHash, randomBytes } from 'crypto';

function b64url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function genPkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function genState() {
  return b64url(randomBytes(24));
}
```

### Start Login Flow
1. Start local HTTP server (e.g., Express) on chosen port; implement routes:
   - `GET /auth/callback` — handles code+state, performs token exchanges, writes `auth.json`, then 302 → `/success`
   - `GET /success` — display a simple “Login successful” HTML page
   - `GET /cancel` (optional) — to abort
2. Build authorize URL and open the browser:
```
https://auth.openai.com/oauth/authorize
  ?response_type=code
  &client_id=app_EMoamEEZ73f0CkXaXp7hrann
  &redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2Fauth%2Fcallback
  &scope=openid%20profile%20email%20offline_access
  &code_challenge={S256}
  &code_challenge_method=S256
  &id_token_add_organizations=true
  &codex_cli_simplified_flow=true
  &state={STATE}
  &originator=codex_cli_js
```
3. On callback, verify `state` and that `code` is present, then exchange tokens.

### Token Exchanges
- Code → tokens
```ts
// POST https://auth.openai.com/oauth/token
// headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirectUri,
  client_id: CLIENT_ID,
  code_verifier: pkce.verifier,
});
```
- `id_token` → API key (token exchange)
```ts
// POST https://auth.openai.com/oauth/token
// headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
const body = new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  client_id: CLIENT_ID,
  requested_token: 'openai-api-key',
  subject_token: idToken,
  subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
});
```
- Persist fields to `auth.json` (see storage schema below). Attempt to extract `chatgpt_account_id` from the `id_token` claims and store as `tokens.account_id` if present.

### Storage Schema (`auth.json`)
- Path: `${HOME}/.codex/auth.json` (create parent dir if missing; mode 0600 on Unix)
- JSON structure:
```json
{
  "OPENAI_API_KEY": "sk-...",             
  "tokens": {
    "id_token": "<raw.jwt.string>",
    "access_token": "<opaque-access>",
    "refresh_token": "<opaque-refresh>",
    "account_id": "<chatgpt_account_id>"
  },
  "last_refresh": "<RFC3339>"
}
```

JWT claim extraction (optional helper):
```ts
function parseJwtClaims(rawJwt: string): any {
  const [, payload] = rawJwt.split('.');
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

function getChatgptAccountId(rawJwt: string): string | undefined {
  const claims = parseJwtClaims(rawJwt);
  return claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
}
```

### Token Refresh
- When `last_refresh` is older than 28 days or upon 401s, refresh:
```ts
// POST https://auth.openai.com/oauth/token
// headers: { 'Content-Type': 'application/json' }
const body = {
  client_id: CLIENT_ID,
  grant_type: 'refresh_token',
  refresh_token: auth.tokens.refresh_token,
  scope: 'openid profile email',
};
```
- Update `auth.json` with new tokens and timestamp.

### Request Client Factory
- Always include default headers:
  - `originator: codex_cli_js`
  - `User-Agent: codex_cli_js/<version> (<os>; <arch>) <terminal>`
- Build Authorization based on mode:
  - If `OPENAI_API_KEY` present → `Authorization: Bearer {apiKey}`
  - Else use ChatGPT tokens → `Authorization: Bearer {access_token}` plus `chatgpt-account-id: {account_id}`

Example:
```ts
function buildAuthHeaders(auth) {
  const headers = {
    originator: 'codex_cli_js',
    'User-Agent': 'codex_cli_js/0.1.0',
  } as Record<string, string>;
  if (auth.OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${auth.OPENAI_API_KEY}`;
  } else {
    headers.Authorization = `Bearer ${auth.tokens.access_token}`;
    if (auth.tokens.account_id) headers['chatgpt-account-id'] = auth.tokens.account_id;
  }
  return headers;
}
```

### Responses API Streaming Helper
- Endpoint:
  - OpenAI API: `https://api.openai.com/v1/responses`
  - ChatGPT backend: `https://chatgpt.com/backend-api/codex/responses`
- Request:
  - Method: `POST`
  - Headers: `Accept: text/event-stream`, `OpenAI-Beta: responses=experimental`, plus Authorization and `chatgpt-account-id` when needed.
  - Body: follow the schema Codex uses (key fields listed in Part 1).
- Parse SSE with `eventsource-parser` or a manual line buffer, emitting events like `response.output_text.delta`, `response.output_item.done`, `response.completed`.

Sketch:
```ts
import { fetch } from 'undici';
import { createParser } from 'eventsource-parser';

async function streamResponses(auth, payload) {
  const base = auth.OPENAI_API_KEY ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api/codex';
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(auth),
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental',
      conversation_id: payload.conversation_id,
      session_id: payload.conversation_id,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const parser = createParser((evt) => {
    if (evt.type === 'event') {
      // evt.event (optional), evt.data
      // Parse evt.data JSON and route by evt.event or embedded type field.
    }
  });

  for await (const chunk of res.body) {
    parser.feed(Buffer.from(chunk).toString('utf8'));
  }
}
```

### ChatGPT Backend GET Helper
- `GET https://chatgpt.com/backend-api/wham/tasks/{task_id}`
- Headers from `buildAuthHeaders(auth)` plus `Content-Type: application/json`.

### Security Considerations
- Store `auth.json` with file mode 0600 on Unix; avoid logging tokens.
- Validate `state` on callback; enforce localhost redirect only.
- Backoff/retry on 429/5xx; refresh tokens on 401.

### Minimal End-to-End Flow
1. Start login server; open browser to authorize URL.
2. Handle callback; exchange tokens; write `auth.json`; show success page.
3. Use `auth.json` to call the Responses API via SSE.
4. Periodically refresh tokens when stale or on 401.

### Optional: Azure Responses API Workaround
- If targeting Azure’s Responses API, prefer `store: true` in the payload and preserve item IDs in the request (Codex applies a workaround here).

---

This spec mirrors Codex CLI’s Rust implementation so a Node.js app can interoperate and behave consistently with respect to authentication, storage, and request semantics.

