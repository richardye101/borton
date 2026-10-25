# Borton Svelte Web Migration

## Goal

Replace Borton's hand-written browser module with a compiled Svelte interface while preserving every private Node API, session behavior, and current expense-entry workflow.

## Design

The Node service remains the only server. It continues to serve `web/`, enforce the WireGuard allow-list, issue trusted sessions, authenticate password fallback, and call Actual/Gemini. Svelte source lives in `frontend/`; Vite compiles it into the existing `web/` directory before the service starts.

The Svelte app keeps the existing interaction model: Home is the default, Summary is cached client-side with explicit refresh, Add and Check are deliberate actions, and Chat stays a floating panel. The searchable account/category picker must open on the first focus or click, show a compact rectangular list, and accept an exact matching choice. Notes remain multiline and offer browser speech dictation when the browser exposes it.

## Constraints

- Keep the private `web-server.mjs`, `web-app.mjs`, Actual, Gemini, and authentication APIs unchanged.
- Do not introduce Docker, a public URL, or a separate frontend server.
- Build output goes to `web/`; source and generated output must not be confused.
- `borton-web.service` must build the frontend before starting the Node server.
- Preserve desktop side rail, mobile Home-first navigation, and the amount privacy setting.
- Keep production validation: `npm test`, `node tools/test_agent.mjs`, frontend build, and live session/bootstrap checks.
