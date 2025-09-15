# Migration: OpenAI → Localhost Provider

This repository has been refactored to remove all direct integrations with the OpenAI API and to disable authentication across the codebase. Model calls now target a local server by default.

## Summary of Changes

- Default provider now targets `http://localhost:3000/v1`.
- Authentication flows (API key, ChatGPT login) are disabled by default for the built‑in provider.
- Environment variables cleaned up for local usage.

## Configuration

Provide the base URL via an environment variable if you need to override the default:

- `LOCALHOST_BASE_URL` (default: `http://localhost:3000/v1`)

An example `.env.example` is included at repo root:

```
PROVIDER_TARGET=localhost
LOCALHOST_BASE_URL=http://localhost:3000
```

## Behavior

- The built‑in provider key `openai` now points to the local server and does not require any authentication.
- SSE/Responses API is used when available; otherwise, fallback provider configuration can be set in `~/.codex/config.toml`.

## Replaced Endpoints

- Calls previously destined to `https://api.openai.com/v1/responses` now resolve to `${LOCALHOST_BASE_URL}/responses` (default: `http://localhost:3000/v1/responses`).

## Notes

- If you had custom `model_provider` entries referencing OpenAI, either remove them or update `base_url` to your local server and set `requires_openai_auth = false`.

