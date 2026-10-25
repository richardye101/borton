# Borton Svelte Web Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Borton's current browser interface to a Svelte build while retaining the Node server and all existing private APIs.

**Architecture:** Vite compiles Svelte source from `frontend/` into the server's existing `web/` static directory. Components call the current JSON/multipart API directly; Node remains responsible for authentication, privacy, Actual writes, and Gemini calls.

**Tech Stack:** Node 22, Svelte 5, Vite, existing Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-25-svelte-web-migration.md`

## Global Constraints

- Preserve every `/api/*` endpoint and cookie/CSRF behavior.
- Build locally on the LXC; do not add Docker, a public URL, or another service.
- Serve only generated assets from `web/`.
- Keep the account/category picker first-click responsive and non-pill-shaped.

## Review Focus

- A trusted WireGuard visit still opens the compiled app without a password prompt.
- Picker click/focus displays matches before text is entered; selecting a match writes its stable ID.
- An unrecognized typed picker value cannot submit an expense.
- Existing Summary cache/refresh, amount hiding, batch review, upload, and Chat requests use the existing API contracts.
- A systemd restart rebuilds the assets before Node serves them.

---

### Task 1: Build pipeline and static output

**Files:**
- Create: `frontend/index.html`, `frontend/src/main.js`, `frontend/src/App.svelte`, `vite.config.js`
- Modify: `package.json`, `package-lock.json`, `.gitignore`, `borton-web.service`
- Delete: `web/index.html`, `web/app.js`, `web/app.css`, `web/client-state.mjs`

**Interfaces:**
- Consumes: the existing static serving path `web/` in `web.mjs`.
- Produces: `npm run build`, which writes an app entry point and styles into `web/`.

- [ ] Write a failing build-pipeline assertion that requires `npm run build` to produce `web/index.html` and JavaScript assets.
- [ ] Run it and confirm it fails before Vite configuration exists.
- [ ] Add Svelte/Vite dependencies, source entry point, Vite output configuration, and a service `ExecStartPre` build step.
- [ ] Run the build assertion, `npm test`, and `node tools/test_agent.mjs`.
- [ ] Commit `build: add Svelte frontend pipeline`.

### Task 2: Shared Svelte API and picker primitives

**Files:**
- Create: `frontend/src/lib/api.js`, `frontend/src/lib/expense-form.js`, `frontend/src/lib/Picker.svelte`, `frontend/src/lib/DictationButton.svelte`
- Create: `test/expense-form.test.mjs`

**Interfaces:**
- Consumes: CSRF token returned by `GET /api/session` or `POST /login`; `accounts` and `categories` from `/api/bootstrap`.
- Produces: `request(path, options)`, `matchItem(items, value)`, and reusable picker/dictation components.

- [ ] Write failing tests for exact case-insensitive account/category matching and unknown values.
- [ ] Run the focused test and confirm it fails because the helper is absent.
- [ ] Implement the helper, API wrapper, compact picker, and browser speech-recognition control.
- [ ] Run focused and full tests, then build.
- [ ] Commit `feat: add Svelte expense entry primitives`.

### Task 3: Svelte app workflows

**Files:**
- Modify: `frontend/src/App.svelte`, `frontend/src/main.js`
- Create: `frontend/src/app.css`

**Interfaces:**
- Consumes: Task 2 primitives and every current Node API response.
- Produces: Home, Summary, Add review, receipt check, floating Chat, amount privacy, and responsive navigation.

- [ ] Port trusted-session boot and password fallback first, then Home quick add/search with picker validation.
- [ ] Port Summary cached reports, refresh, filters, drill-down, and the amount toggle.
- [ ] Port batch review, receipt extraction, and floating Chat without altering API paths or payloads.
- [ ] Build and manually inspect desktop and narrow-screen output; run the full test suite.
- [ ] Commit `feat: migrate Borton interface to Svelte`.

### Task 4: Deployment verification and documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: generated `web/` assets and the existing native `borton-web` unit.
- Produces: repeatable native deployment steps that build assets before restart.

- [ ] Update the web deployment instructions with the build command and service behavior.
- [ ] On the LXC, run `npm ci`, `npm run build`, restart `borton-web`, and verify trusted session plus authenticated bootstrap.
- [ ] Commit `docs: describe Borton Svelte build`.
