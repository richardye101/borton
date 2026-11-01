import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat receipt attachment opens a dismissible image preview without removing it', async () => {
  const app = await readFile(new URL('../frontend/src/App.svelte', import.meta.url), 'utf8');
  const css = await readFile(new URL('../frontend/src/app.css', import.meta.url), 'utf8');
  assert.match(app, /let receiptPreviewOpen = false;/);
  assert.match(app, /on:click=\{\(\) => receiptPreviewOpen = true\}/);
  assert.match(app, /on:click\|stopPropagation=\{clearPendingReceipt\}/);
  assert.match(app, /class="receipt-preview-modal"/);
  assert.match(app, /class="chat-input-wrap"/);
  assert.match(css, /width:min\(34rem,calc\(100vw - 2rem\)\)/);
  assert.match(css, /height:min\(70vh,calc\(100vh - 2rem\)\);min-width:0;min-height:0/);
  assert.match(css, /\.receipt-preview-modal img\{display:block;width:100%;height:100%/);
  assert.match(css, /@media\(hover:hover\)\{\.chat-input-wrap \.chat-attachment>\.secondary\{opacity:0/);
  assert.match(css, /\.chat-input-wrap\.with-receipt textarea\{min-height:7rem;padding:6\.15rem \.7rem \.65rem\}/);
});
