import { createSummaryCache } from './client-state.mjs';

const state = { csrf: '', boot: null, view: 'home', batch: [], messages: [], summaryCache: createSummaryCache(), summaryPeriod: '90', hide: localStorage.getItem('borton-hide-amounts') === '1' };
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; };
const money = (cents) => state.hide ? '••••' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: state.boot?.currency || 'CAD' }).format((cents || 0) / 100);
const pickerItems = (type) => type === 'account' ? state.boot.accounts : state.boot.categories;
const selected = (items, value) => items.find((item) => item.id === value || item.name.toLocaleLowerCase() === String(value || '').trim().toLocaleLowerCase());

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (method !== 'GET') headers['x-csrf-token'] = state.csrf;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : form });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed.');
  return data;
}

function picker({ id, type, label, selectedId = '', attrs = '' }) {
  const items = pickerItems(type); const current = selected(items, selectedId);
  return `<label class="picker">${label}<span class="picker-control"><input id="${id}" value="${esc(current?.name || '')}" placeholder="Search ${type === 'account' ? 'accounts' : 'categories'}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-menu" data-picker="${type}" data-picker-menu="${id}-menu" ${attrs}><span class="picker-menu" id="${id}-menu" role="listbox" hidden></span></span></label>`;
}

function hidePicker(input) {
  const menu = document.getElementById(input.dataset.pickerMenu);
  if (!menu) return;
  menu.hidden = true; input.setAttribute('aria-expanded', 'false');
}

function showPicker(input) {
  const menu = document.getElementById(input.dataset.pickerMenu); if (!menu) return;
  const query = input.value.trim().toLocaleLowerCase();
  const matches = pickerItems(input.dataset.picker).filter((item) => item.name.toLocaleLowerCase().includes(query)).sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(query)) - Number(a.name.toLocaleLowerCase().startsWith(query)) || a.name.localeCompare(b.name)).slice(0, 10);
  menu.innerHTML = matches.map((item) => `<button type="button" role="option" data-picker-value="${esc(item.name)}">${esc(item.name)}</button>`).join('') || '<span class="muted">No matches</span>';
  menu.hidden = false; input.setAttribute('aria-expanded', 'true');
  menu.querySelectorAll('[data-picker-value]').forEach((button) => {
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => { input.value = button.dataset.pickerValue; input.dispatchEvent(new Event('change', { bubbles: true })); hidePicker(input); };
  });
}

function bindPickers(root) {
  root.querySelectorAll('[data-picker]').forEach((input) => {
    input.onfocus = () => showPicker(input);
    input.oninput = () => showPicker(input);
    input.onkeydown = (event) => { if (event.key === 'Escape') hidePicker(input); };
    input.onblur = () => setTimeout(() => hidePicker(input), 150);
  });
}

function bindDictation(root) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  root.querySelectorAll('[data-dictate]').forEach((button) => {
    if (!Recognition) { button.disabled = true; button.title = 'Use your device keyboard dictation in this browser.'; return; }
    let recognition;
    button.onclick = () => {
      if (recognition) { recognition.stop(); return; }
      const target = document.getElementById(button.dataset.dictate); const initial = target.value.trim(); let transcript = '';
      recognition = new Recognition(); recognition.lang = navigator.language || 'en-CA'; recognition.interimResults = true; recognition.continuous = true;
      recognition.onstart = () => { button.textContent = 'Stop dictation'; button.setAttribute('aria-pressed', 'true'); };
      recognition.onresult = (event) => { transcript = [...event.results].map((result) => result[0].transcript).join(''); target.value = [initial, transcript.trim()].filter(Boolean).join(initial && transcript ? ' ' : ''); target.dispatchEvent(new Event('change', { bubbles: true })); };
      recognition.onend = () => { recognition = null; button.textContent = 'Dictate'; button.setAttribute('aria-pressed', 'false'); };
      recognition.onerror = () => { recognition?.stop(); };
      recognition.start();
    };
  });
}

function layout(html) {
  $('#content').innerHTML = html;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
}

function setAmountVisibility(hidden) {
  state.hide = hidden;
  localStorage.setItem('borton-hide-amounts', hidden ? '1' : '0');
}

function amountToggle(id) {
  return `<button type="button" class="secondary amount-toggle" id="${id}" aria-pressed="${state.hide}">${state.hide ? 'Show amounts' : 'Hide amounts'}</button>`;
}

function home() {
  layout(`<section class="card"><div class="toolbar page-toolbar"><h2>Recent expenses</h2><div class="toolbar-actions">${amountToggle('hide-amounts')}<button type="button" class="secondary" id="refresh">Refresh</button></div></div><section class="quick-add"><h3>Quick add</h3><form id="quick"><div class="quick-fields"><label>Merchant<input name="merchant" placeholder="Merchant" required></label><label>Amount<input name="amount" placeholder="Amount" inputmode="decimal" required></label><label>Date<input name="date" type="date" value="${today()}" required></label>${picker({ id: 'quick-account', type: 'account', label: 'Paid from', attrs: 'name="account" required' })}${picker({ id: 'quick-category', type: 'category', label: 'Category', attrs: 'name="category" required' })}</div><label class="quick-note">Notes<textarea id="quick-note" name="note" rows="3" placeholder="What was this for?"></textarea><button type="button" class="secondary dictate" data-dictate="quick-note" aria-pressed="false">Dictate</button></label><div class="quick-actions"><button>Add expense</button><output id="quick-out"></output></div></form></section><div class="toolbar search-bar"><input id="search" placeholder="Search merchant or notes"><button id="search-go">Search</button></div><table class="transactions"><thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th>Category</th><th>Notes</th><th class="amount">Amount</th></tr></thead><tbody id="rows"></tbody></table></section>`);
  renderRows(state.boot.transactions);
  bindPickers($('#quick')); bindDictation($('#quick'));
  $('#hide-amounts').onclick = () => { setAmountVisibility(!state.hide); home(); };
  $('#refresh').onclick = loadBoot;
  $('#search-go').onclick = async () => renderRows(await api(`/api/transactions?query=${encodeURIComponent($('#search').value)}`));
  $('#quick').onsubmit = quickAdd;
}

function renderRows(rows) {
  $('#rows').innerHTML = rows.map((row) => `<tr><td>${esc(row.date)}</td><td>${esc(row.merchant)}</td><td>${esc(row.account)}</td><td>${esc(row.category)}</td><td>${esc(row.note) || '<span class="muted">—</span>'}</td><td class="amount">${money(row.amountCents)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No transactions found.</td></tr>';
}

async function quickAdd(event) {
  event.preventDefault();
  const form = new FormData(event.target); const account = selected(state.boot.accounts, form.get('account')); const category = selected(state.boot.categories, form.get('category')); const out = $('#quick-out');
  if (!account || !category) { out.textContent = 'Choose an account and category from the matching suggestions.'; return; }
  const row = { clientId: crypto.randomUUID(), merchant: form.get('merchant'), amountCents: Math.round(Number(form.get('amount')) * 100), date: form.get('date'), accountId: account.id, categoryId: category.id, note: form.get('note'), duplicateAcknowledged: false };
  await saveRows([row], out);
}

async function saveRows(rows, out) {
  try {
    const checked = await api('/api/batches/validate', { method: 'POST', body: { rows } });
    if (checked.rows.some((row) => row.status !== 'ready')) { state.batch = checked.rows; state.view = 'add'; add('Review likely duplicate or missing fields.'); return; }
    const result = await api('/api/batches/submit', { method: 'POST', body: { requestId: crypto.randomUUID(), rows: checked.rows } });
    if (result.status !== 'complete') throw Error(result.error || result.status);
    state.summaryCache.clear(); state.batch = []; state.view = 'home'; out.textContent = 'Saved.'; await loadBoot();
  } catch (error) { out.textContent = error.message; }
}

function add(message = '') {
  layout(`<section class="card"><h2>Review expenses</h2><p class="muted">${esc(message)}</p><section id="batch"></section></section>`);
  renderBatch();
}

function renderBatch() {
  const host = $('#batch');
  if (!state.batch.length) { host.innerHTML = '<p class="muted">Use Check an expense to upload a receipt, or add one from Home.</p>'; return; }
  host.innerHTML = state.batch.map((row, index) => `<article class="receipt"><label>Merchant<input data-i="${index}" data-k="merchant" value="${esc(row.merchant)}"></label><label>Amount<input data-i="${index}" data-k="amountCents" value="${(row.amountCents / 100).toFixed(2)}"></label><label>Date<input data-i="${index}" data-k="date" type="date" value="${esc(row.date)}"></label>${picker({ id: `batch-${index}-account`, type: 'account', label: 'Paid from', selectedId: row.accountId, attrs: `data-i="${index}" data-k="accountId"` })}${picker({ id: `batch-${index}-category`, type: 'category', label: 'Category', selectedId: row.categoryId, attrs: `data-i="${index}" data-k="categoryId"` })}<label class="receipt-note">Notes<textarea id="batch-${index}-note" data-i="${index}" data-k="note" rows="2" placeholder="Notes">${esc(row.note)}</textarea><button type="button" class="secondary dictate" data-dictate="batch-${index}-note" aria-pressed="false">Dictate</button></label>${row.duplicates?.length ? `<label class="duplicate-choice">Likely duplicate <input data-i="${index}" data-k="duplicateAcknowledged" type="checkbox"> intentionally new</label>` : ''}</article>`).join('') + '<button id="save-batch">Save expenses</button><output id="batch-out"></output>';
  host.querySelectorAll('[data-k]').forEach((element) => {
    element.onchange = () => {
      const row = state.batch[element.dataset.i];
      const value = element.dataset.picker ? selected(pickerItems(element.dataset.picker), element.value)?.id || '' : element.type === 'checkbox' ? element.checked : element.dataset.k === 'amountCents' ? Math.round(Number(element.value) * 100) : element.value;
      row[element.dataset.k] = value;
    };
  });
  bindPickers(host); bindDictation(host);
  $('#save-batch').onclick = () => saveRows(state.batch, $('#batch-out'));
}

function summary() {
  layout(`<section class="card"><div class="toolbar page-toolbar"><h2>Summary</h2><div class="toolbar-actions"><select id="period"><option value="30" ${state.summaryPeriod === '30' ? 'selected' : ''}>Last 30 days</option><option value="90" ${state.summaryPeriod === '90' ? 'selected' : ''}>Last 90 days</option><option value="365" ${state.summaryPeriod === '365' ? 'selected' : ''}>Last 12 months</option><option value="all" ${state.summaryPeriod === 'all' ? 'selected' : ''}>All time</option></select>${amountToggle('summary-amounts')}<button id="sum-refresh" class="secondary">Refresh</button></div></div><div id="summary" class="muted">Loading…</div></section>`);
  const load = async (force = false) => { const period = $('#period').value; let data = state.summaryCache.get(period); if (!data || force) { data = await api(`/api/summary?period=${period}${force ? '&force=true' : ''}`); state.summaryCache.set(period, data); } renderSummary(data); };
  $('#period').onchange = () => { state.summaryPeriod = $('#period').value; load(); }; $('#sum-refresh').onclick = () => load(true); $('#summary-amounts').onclick = () => { setAmountVisibility(!state.hide); summary(); };
  load().catch((error) => { $('#summary').textContent = error.message; });
}

function renderSummary(summaryData) {
  const list = (rows) => `<ol>${rows.map((row) => `<li><button data-filter='${esc(JSON.stringify(row.filters))}'><span>${esc(row.name)} <small>(${row.count})</small></span><strong>${money(row.amountCents)}</strong></button></li>`).join('')}</ol>`;
  $('#summary').innerHTML = `<div class="summary-total"><span>${summaryData.start} to ${summaryData.end}</span><strong>${money(summaryData.totalCents)}</strong><small>${summaryData.count} expenses</small></div><div class="breakdown-grid"><article><h3>Category</h3>${list(summaryData.byCategory)}</article><article><h3>Account</h3>${list(summaryData.byAccount)}</article><article><h3>Month</h3>${list(summaryData.byMonth)}</article></div>`;
  $('#summary').querySelectorAll('[data-filter]').forEach((button) => { button.onclick = () => detail(JSON.parse(button.dataset.filter)); });
}

async function detail(filters) {
  state.view = 'summary'; layout('<section class="card"><button id="back" class="secondary">← Summary</button><h2>Summary detail</h2><div id="detail" class="muted">Loading…</div></section>'); $('#back').onclick = summary;
  const data = await api(`/api/transactions?paged=true&limit=100&${new URLSearchParams(filters)}`);
  $('#detail').innerHTML = `<table class="transactions"><tbody>${data.rows.map((row) => `<tr><td>${esc(row.date)}</td><td>${esc(row.merchant)}</td><td>${esc(row.note)}</td><td class="amount">${money(row.amountCents)}</td></tr>`).join('')}</tbody></table>`;
}

function check() {
  layout('<section class="card"><h2>Check an expense</h2><p>Upload a receipt or ask Chat when you only remember part of it.</p><form id="upload"><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" required><button>Read receipt</button><output></output></form><details><summary>Enter known details</summary><button id="open-chat">Ask in Chat</button></details></section>');
  $('#upload').onsubmit = async (event) => { event.preventDefault(); const out = $('#upload output'); try { const data = await api('/api/extract', { method: 'POST', form: new FormData(event.target) }); state.batch.push(...data.rows); state.view = 'add'; add(); } catch (error) { out.textContent = error.message; } };
  $('#open-chat').onclick = () => openChat('Did I already make this purchase? I remember: ');
}

function today() { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`; }
function openChat(prefill = '') { $('#chat').hidden = false; const text = $('#assistant-form textarea'); text.value = prefill; text.focus(); renderMessages(); }
function renderMessages() { $('#messages').innerHTML = state.messages.map((message) => `<div class="message ${message.user ? 'user' : ''}">${esc(message.text)}</div>`).join('') || '<p class="muted">Ask about an expense, a duplicate, or a bulk change.</p>'; }
async function boot() { try { const session = await fetch('/api/session'); if (session.ok) { state.csrf = (await session.json()).csrf; return signedIn(); } } catch {} }
async function signedIn() {
  $('#login').hidden = true; $('#shell').hidden = false; $('#chat-toggle').onclick = () => openChat(); $('#chat-close').onclick = () => { $('#chat').hidden = true; };
  $('#assistant-form').onsubmit = async (event) => { event.preventDefault(); const text = new FormData(event.target).get('text'); if (!text) return; state.messages.push({ user: true, text }); renderMessages(); const response = await api('/api/assistant/message', { method: 'POST', body: { text } }); state.messages.push({ text: response.text }); renderMessages(); };
  document.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => show(button.dataset.view); }); await loadBoot();
}
async function loadBoot() { state.boot = await api('/api/bootstrap'); $('#synced').textContent = `Synced ${new Date(state.boot.syncedAt).toLocaleTimeString()}`; show(state.view); }
function show(view) { state.view = view; ({ home, summary, add, check })[view](); }
$('#login-form').onsubmit = async (event) => { event.preventDefault(); try { const response = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: new FormData(event.target).get('password') }) }); const data = await response.json(); if (!response.ok) throw Error(data.error); state.csrf = data.csrf; await signedIn(); } catch (error) { $('#login-form output').textContent = error.message; } };
boot();
