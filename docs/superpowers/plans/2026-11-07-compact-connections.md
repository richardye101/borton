# Compact Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace oversized Plaid connection forms with compact, scannable institution cards.

**Architecture:** Keep the existing Connections data and APIs. Reshape only the Svelte markup and CSS around an institution summary, mapping rows, and a small action footer.

**Tech Stack:** Svelte 5, CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-07-compact-connections-design.md`

## Global Constraints

- Preserve existing account mapping, sync, reconnect, and disconnect behavior.
- Use no new dependencies or API routes.

## Review Focus

- Multiple accounts must remain individually mappable; test source markup in Task 1.
- Disconnect must remain available but visually secondary; test source markup in Task 1.

### Task 1: Compact institution cards

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/app.css`
- Test: `test/frontend-receipt-preview.test.mjs`

- [ ] Write a failing source test for compact mapping rows and a disclosed disconnect action.
- [ ] Run `node --test test/frontend-receipt-preview.test.mjs` and verify it fails.
- [ ] Implement compact card markup and responsive CSS without changing event handlers.
- [ ] Run the focused test and `npm run build`; verify both pass.
