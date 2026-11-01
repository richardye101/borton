import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat receipt attachment opens a dismissible image preview without removing it', async () => {
  const app = await readFile(new URL('../frontend/src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /let receiptPreviewOpen = false;/);
  assert.match(app, /on:click=\{\(\) => receiptPreviewOpen = true\}/);
  assert.match(app, /on:click\|stopPropagation=\{clearPendingReceipt\}/);
  assert.match(app, /class="receipt-preview-modal"/);
});
