// Node.js script to:
// 1) Open browser for OAuth login to OpenAI (ChatGPT) using PKCE
// 2) Handle local callback, exchange code -> tokens and id_token -> API key
// 3) Persist ./session.json (access token, optional apiKey)
// 4) Send a sample question using OpenAI Responses API (prefer platform with apiKey; fallback to ChatGPT backend)

const http = require('http');
const https = require('https');
const { URL } = require('url');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');

// ===== Config =====
const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_PORT = 1455; // if in use we'll fall back to an ephemeral port

function codexHome() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  return home;
}

function authFilePath() {
  return path.join(codexHome(), 'auth.json');
}

function sessionFilePath() {
  // Store session.json alongside this script, as requested
  return path.join(__dirname, 'session.json');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function genPkce() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function genState() {
  return base64url(crypto.randomBytes(24));
}

function openIncognito(url) {
  const platform = process.platform;

  function trySpawn(cmd, args) {
    try {
      const p = child_process.spawn(cmd, args, { stdio: 'ignore', detached: true });
      p.unref();
      return true;
    } catch (_) {
      return false;
    }
  }

  // Try platform-specific incognito/private windows.
  if (platform === 'darwin') {
    // macOS candidates (first one that exists will launch)
    const candidates = [
      ['open', ['-na', 'Google Chrome', '--args', '--incognito', url]],
      ['open', ['-na', 'Brave Browser', '--args', '--incognito', url]],
      ['open', ['-na', 'Microsoft Edge', '--args', '--inprivate', url]],
      ['open', ['-na', 'Firefox', '--args', '-private-window', url]],
    ];
    for (const [cmd, args] of candidates) {
      if (trySpawn(cmd, args)) return;
    }
    // Fallback: normal open
    trySpawn('open', [url]);
    return;
  }

  if (platform === 'win32') {
    // Windows: try Edge, Chrome, Firefox
    const cmds = [
      ['cmd', ['/c', 'start', '', 'msedge', '--inprivate', url]],
      ['cmd', ['/c', 'start', '', 'chrome', '--incognito', url]],
      ['cmd', ['/c', 'start', '', 'firefox', '-private-window', url]],
    ];
    for (const [cmd, args] of cmds) {
      if (trySpawn(cmd, args)) return;
    }
    // Fallback
    trySpawn('cmd', ['/c', 'start', '', url]);
    return;
  }

  // Linux / others: try common browsers with incognito flags
  const linuxCandidates = [
    ['google-chrome', ['--incognito', url]],
    ['chromium', ['--incognito', url]],
    ['chromium-browser', ['--incognito', url]],
    ['brave-browser', ['--incognito', url]],
    ['microsoft-edge', ['--inprivate', url]],
    ['firefox', ['-private-window', url]],
  ];
  for (const [cmd, args] of linuxCandidates) {
    if (trySpawn(cmd, args)) return;
  }
  // Fallback
  trySpawn('xdg-open', [url]);
}

function httpsPostForm(urlString, formObj) {
  const u = new URL(urlString);
  const body = new URLSearchParams(formObj).toString();
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + (u.search || ''),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (e) {
            reject(new Error('Failed to parse JSON: ' + e.message));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsPostJson(urlString, headers, jsonObj) {
  const u = new URL(urlString);
  const body = JSON.stringify(jsonObj);
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + (u.search || ''),
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      headers || {}
    ),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, text: data });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJwtClaims(rawJwt) {
  try {
    const parts = rawJwt.split('.');
    if (parts.length < 2) return {};
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(payload, 'base64');
    return JSON.parse(buf.toString('utf8')) || {};
  } catch (e) {
    return {};
  }
}

function readAuthFromHome() {
  const home = process.env.HOME || os.homedir();
  const p = path.join(home, '.codex', 'auth.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = { apiKey: undefined, token: undefined, accountId: undefined };
    if (raw && typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim()) {
      out.apiKey = raw.OPENAI_API_KEY.trim();
    }
    if (raw?.tokens?.access_token) out.token = raw.tokens.access_token;
  // Always prefer chatgpt_account_id from JWT claims (more reliable)
  if (raw?.tokens?.id_token) {
    const claims = parseJwtClaims(raw.tokens.id_token) || {};
    const oa = (claims && claims['https://api.openai.com/auth']) || {};
    if (typeof oa.chatgpt_account_id === 'string') out.accountId = oa.chatgpt_account_id;
  }
  if (!out.accountId && raw?.tokens?.account_id) out.accountId = raw.tokens.account_id;
  return (out.apiKey || out.token) ? out : null;
  } catch (_) {
    return null;
  }
}

function buildAuthHeaders(auth) {
  const headers = {
    originator: 'codex_cli_js',
    'User-Agent': 'codex_cli_js/0.1.0',
  };
  if (auth && auth.OPENAI_API_KEY) {
    headers['Authorization'] = `Bearer ${auth.OPENAI_API_KEY}`;
  } else if (auth && auth.tokens && auth.tokens.access_token) {
    headers['Authorization'] = `Bearer ${auth.tokens.access_token}`;
    if (auth.tokens.account_id) headers['chatgpt-account-id'] = auth.tokens.account_id;
  }
  return headers;
}

function writeSessionJson(token, accountId, apiKey) {
  const data = { token, accountId, apiKey, savedAt: Date.now() };
  fs.writeFileSync(sessionFilePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function readSessionJson() {
  const p = sessionFilePath();
  if (!fs.existsSync(p)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
  // Normalize into { token, accountId, apiKey }
  const norm = { token: undefined, accountId: undefined, apiKey: undefined };
  // Prefer explicit fields written by this script
  if (typeof raw.token === 'string') norm.token = raw.token;
  if (typeof raw.accountId === 'string') norm.accountId = raw.accountId;
  if (typeof raw.apiKey === 'string') norm.apiKey = raw.apiKey;
  // Fall back to legacy/auth-like shapes
  // Some files may have tokens.access_token or top-level access_token
  if (!norm.token) norm.token = raw?.tokens?.access_token || raw?.access_token || undefined;
  // Account id may be under tokens.account_id or derivable from id_token claims
  if (!norm.accountId) norm.accountId = raw?.tokens?.account_id || undefined;
  if (!norm.accountId && raw?.tokens?.id_token) {
    const claims = parseJwtClaims(raw.tokens.id_token) || {};
    const oa = (claims && claims['https://api.openai.com/auth']) || {};
    if (typeof oa.chatgpt_account_id === 'string') norm.accountId = oa.chatgpt_account_id;
  }
  // Platform API key may be under OPENAI_API_KEY
  if (!norm.apiKey && typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim()) {
    norm.apiKey = raw.OPENAI_API_KEY.trim();
  }
  return norm.token ? norm : null;
}

function uuidLike() {
  // simple uuid v4-ish
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.toString('hex');
  return `${s.substr(0, 8)}-${s.substr(8, 4)}-${s.substr(12, 4)}-${s.substr(16, 4)}-${s.substr(20)}`;
}

async function exchangeCodeForTokens({ code, redirectUri, pkce }) {
  const res = await httpsPostForm(`${ISSUER}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
  });
  // Expected fields: id_token, access_token, refresh_token
  if (!res.id_token) throw new Error('No id_token in token response');
  if (!res.refresh_token) throw new Error('No refresh_token in token response');
  return res;
}

async function exchangeIdTokenForApiKey(idToken) {
  const res = await httpsPostForm(`${ISSUER}/oauth/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: CLIENT_ID,
    requested_token: 'openai-api-key',
    subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
  });
  if (!res.access_token) throw new Error('API key exchange failed');
  return res.access_token;
}

function saveTokens({ id_token, access_token, refresh_token, maybeApiKey }) {
  const claims = parseJwtClaims(id_token) || {};
  const oa = (claims && claims['https://api.openai.com/auth']) || {};
  const accountId = oa.chatgpt_account_id || undefined;

  // Only persist session.json as requested
  writeSessionJson(access_token, accountId, maybeApiKey);
  return { token: access_token, accountId, apiKey: maybeApiKey };
}

async function startLoginServerAndAuth() {
  const pkce = genPkce();
  const state = genState();

  let redirectUri = undefined;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost`);
      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        if (!code || gotState !== state) {
          res.statusCode = 400;
          res.end('Invalid state or missing code');
          return;
        }

        // Perform token exchange
        const tokens = await exchangeCodeForTokens({ code, redirectUri: redirectUri, pkce });
        let apiKey;
        try {
          apiKey = await exchangeIdTokenForApiKey(tokens.id_token);
        } catch (e) {
          // API key exchange may fail; continue with ChatGPT tokens
          apiKey = undefined;
        }
        const saved = saveTokens({
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          maybeApiKey: apiKey,
        });

        res.statusCode = 302;
        res.setHeader('Location', '/success');
        res.end();

        // Close server shortly after success redirect
        setTimeout(() => server.close(), 250);
        return;
      }

      if (url.pathname === '/success') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<html><body><h1>Login successful</h1>You can close this tab.</body></html>');
        return;
      }

      res.statusCode = 404;
      res.end('Not Found');
    } catch (e) {
      res.statusCode = 500;
      res.end('Server error: ' + e.message);
    }
  });

  // Try default port, fallback to ephemeral if in use
  const port = await new Promise((resolve) => {
    server.once('error', () => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    server.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(DEFAULT_PORT));
  });

  redirectUri = `http://localhost:${port}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: state,
    originator: 'codex_cli_js',
  });
  const authUrl = `${ISSUER}/oauth/authorize?${params.toString()}`;

  console.log('Opening incognito/private browser to authenticate at:', authUrl);
  openIncognito(authUrl);

  // Wait until server closes (after success)
  await new Promise((resolve) => server.on('close', resolve));
}

function httpsPostSSE(urlString, headers, jsonBody, onEvent) {
  const u = new URL(urlString);
  const body = JSON.stringify(jsonBody);
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + (u.search || ''),
    headers: Object.assign(
      {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      headers || {}
    ),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
        return;
      }

      let currentEvent = null;
      let buffer = '';

      const flush = () => {
        const lines = buffer.split(/\r?\n/);
        buffer = '';
        for (const line of lines) {
          if (!line) {
            // dispatch event chunk end
            continue;
          }
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            try {
              const parsed = data ? JSON.parse(data) : null;
              onEvent({ event: currentEvent, data: parsed });
            } catch (_) {
              // ignore parse errors for now
            }
          }
        }
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        flush();
      });
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function streamChatCompletions(urlBase, headers, model, question) {
  const url = `${urlBase}/chat/completions`;
  const payload = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: 'Answer clearly and concisely.' },
      { role: 'user', content: question },
    ],
  };

  let fullText = '';
  await httpsPostSSE(url, headers, payload, ({ event, data }) => {
    // Chat Completions chunks typically have { choices: [{ delta: { content } }] }
    if (data && Array.isArray(data.choices)) {
      const delta = data.choices[0] && data.choices[0].delta;
      const content = delta && delta.content;
      if (typeof content === 'string' && content.length) {
        fullText += content;
        process.stdout.write(content);
      }
    }
  });
  return fullText;
}

const PLATFORM_DEFAULT_MODEL = 'gpt-5';
const CHATGPT_DEFAULT_MODEL = 'o4-mini';
const CHATGPT_FALLBACK_MODELS = ['o4', 'gpt-4o', 'gpt-4o-mini'];

function parseModelArg() {
  // CLI flag --model <name> takes precedence, then env MODEL
  const idx = process.argv.indexOf('--model');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (process.env.MODEL && process.env.MODEL.trim()) return process.env.MODEL.trim();
  return null;
}

async function askQuestion(question, creds) {
  const session = creds;
  if (!session || (!session.apiKey && !session.token)) {
    throw new Error('No credentials provided');
  }

  const convId = uuidLike();
  const headers = {
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.0.0',
    Authorization: `Bearer ${session.token}`,
  };
  if (session.accountId) headers['chatgpt-account-id'] = session.accountId;

  // Prefer OpenAI platform if apiKey is present; else ChatGPT backend
  const usePlatform = !!session.apiKey;
  const base = usePlatform ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api/codex';
  const url = `${base}/responses`;
  const debug = process.argv.includes('--debug');
  console.log(`Endpoint: ${url}`);
  if (!usePlatform) console.log(`chatgpt-account-id header set: ${headers['chatgpt-account-id'] ? 'yes' : 'no'}`);

  if (usePlatform) {
    // Replace headers for platform request
    headers.Authorization = `Bearer ${session.apiKey}`;
    delete headers['chatgpt-account-id'];
  }
  headers['OpenAI-Beta'] = 'responses=experimental';
  headers['conversation_id'] = convId;
  headers['session_id'] = convId;

  // Choose model
  const requestedModel = parseModelArg();
  let model = requestedModel || (usePlatform ? PLATFORM_DEFAULT_MODEL : CHATGPT_DEFAULT_MODEL);
  if (!usePlatform && /^gpt-5/i.test(model)) {
    throw new Error('Model gpt-5 requires platform API access. Set OPENAI_API_KEY in ~/.codex/auth.json.');
  }

  // Build payload; include text.verbosity for gpt-5 family
  const payload = {
    model,
    instructions: 'Answer clearly and concisely.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] },
    ],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: convId,
  };
  if (/^gpt-5/i.test(model)) {
    payload.text = { verbosity: 'medium' };
  }

  function sanitizeHeaders(h) {
    const out = { ...h };
    if (out.Authorization) out.Authorization = 'Bearer ***';
    if (out['chatgpt-account-id']) {
      const v = String(out['chatgpt-account-id']);
      out['chatgpt-account-id'] = v.length > 10 ? `${v.slice(0, 8)}…` : 'set';
    }
    return out;
  }
  if (debug) {
    console.log('Mode:', usePlatform ? 'platform' : 'chatgpt');
    console.log('Model:', model);
    console.log('Headers:', sanitizeHeaders(headers));
    console.log('Payload:', { ...payload });
  }

  // If using ChatGPT backend and this model fails as unsupported, try a simple fallback list
  const tryModels = [model, ...(!usePlatform && !requestedModel ? CHATGPT_FALLBACK_MODELS.filter((m) => m !== model) : [])];

  let lastErr = null;
  for (const m of tryModels) {
    payload.model = m;
    let fullText = '';
    try {
      await httpsPostSSE(url, headers, payload, ({ event, data }) => {
        const type = event || (data && data.type) || '';
        if (type === 'response.output_text.delta' && data && data.delta) {
          fullText += data.delta;
          process.stdout.write(data.delta);
        }
      });
      console.log(`\n---\nModel: ${m}\nFinal:`, fullText.trim());
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '').toLowerCase();
      if (!msg.includes('unsupported model')) throw e;
      // Fallback to Chat Completions endpoint when /responses returns Unsupported model
      if (!usePlatform) {
        try {
          if (debug) {
            console.log('Falling back to /chat/completions with model:', m);
            console.log('Headers:', sanitizeHeaders(headers));
          }
          const ccText = await streamChatCompletions('https://chatgpt.com/backend-api/codex', headers, m, question);
          console.log(`\n---\nModel (chat.completions): ${m}\nFinal:`, (ccText || '').trim());
          lastErr = null;
          break;
        } catch (e2) {
          // continue to next model
        }
      }
    }
  }
  if (lastErr) throw lastErr;
}

async function main() {
  // Prefer ~/.codex/auth.json if available
  const homeAuth = readAuthFromHome();
  if (homeAuth) {
    const question = process.argv
      .slice(2)
      .filter((a) => a !== '--relogin' && a !== '--import-auth' && a !== '--model')
      .filter((a, i, arr) => !(arr[i-1] === undefined && a === '--model'))
      .join(' ') || 'Say hello in one short sentence.';
    console.log('Using credentials from ~/.codex/auth.json');
    await askQuestion(question, homeAuth);
    return;
  }
  const forceRelogin = process.argv.includes('--relogin');
  const importAuth = process.argv.includes('--import-auth');
  if (importAuth) {
    try {
      const home = process.env.HOME || os.homedir();
      const authPath = path.join(home, '.codex', 'auth.json');
      if (!fs.existsSync(authPath)) {
        console.error('No auth.json found at', authPath);
        process.exit(1);
      }
      const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const apiKey = (raw && typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim()) ? raw.OPENAI_API_KEY.trim() : undefined;
      const token = raw?.tokens?.access_token || raw?.access_token;
      let accountId = raw?.tokens?.account_id;
      if (!accountId && raw?.tokens?.id_token) {
        const claims = parseJwtClaims(raw.tokens.id_token) || {};
        const oa = (claims && claims['https://api.openai.com/auth']) || {};
        if (typeof oa.chatgpt_account_id === 'string') accountId = oa.chatgpt_account_id;
      }
      if (!token) {
        console.error('auth.json missing tokens.access_token; cannot import');
        process.exit(1);
      }
      writeSessionJson(token, accountId, apiKey);
      console.log('Imported auth.json into session.json at', sessionFilePath());
    } catch (e) {
      console.error('Failed to import auth.json:', e.message);
      process.exit(1);
    }
  }
  let session = readSessionJson();
  if (forceRelogin || !session || !session.token) {
    if (forceRelogin) {
      console.log('Forcing re-login (--relogin) …');
    } else {
      console.log('No session found; starting login …');
    }
    await startLoginServerAndAuth();
    session = readSessionJson();
  } else {
    console.log('Using existing session at', sessionFilePath());
  }
  // Ask a sample question
  const question = process.argv
    .slice(2)
    .filter((a) => a !== '--relogin' && a !== '--import-auth' && a !== '--model')
    .filter((a, i, arr) => !(arr[i-1] === undefined && a === '--model'))
    .join(' ') || 'Say hello in one short sentence.';
  await askQuestion(question, session);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
