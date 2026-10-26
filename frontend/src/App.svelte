<script>
  import { onMount, tick } from 'svelte';
  import { request } from './lib/api.js';
  import { createSummaryCache } from './lib/client-state.js';
  import { pathForRoute, routeFromPath } from './lib/router.js';
  import { itemName, matchItem } from './lib/expense-form.js';
  import Picker from './lib/Picker.svelte';
  import DictationButton from './lib/DictationButton.svelte';

  let csrf = '';
  let boot = null;
  let signedIn = false;
  let view = 'home';
  let loginPassword = '';
  let loginError = '';
  let quickError = '';
  let quick = { merchant: '', amount: '', date: today(), account: '', category: '', note: '' };
  let search = '';
  let transactions = [];
  let batch = [];
  let assistantJobs = [];
  let chatOpen = false;
  let chatTab = 'chat';
  let chatText = '';
  let chatPoll = null;
  let hideAmounts = false;
  let summaryPeriod = '90';
  let summaryData = null;
  let sharedData = null;
  let summaryDetail = null;
  let summaryDetailFilters = null;
  let summaryUpdatedAt = null;
  let recentUpdatedAt = null;
  let detailAccount = '';
  let detailCategory = '';
  let hoveredMonth = null;
  let editingId = null;
  let edit = null;
  let editError = '';
  let editSource = '';
  let savingEdit = false;
  let editNotice = null;
  let noticeTimer = null;
  let routeTransactionId = '';
  let highlightedTransactionId = '';
  let tableFilters = { date: '', merchant: '', account: '', category: '', amount: '' };
  let tableSort = { key: 'date', direction: 'desc' };
  let splittingId = null;
  let splitPerson = '';
  let splitMode = 'equal';
  let splitShares = [{ person: '', value: '' }];
  let detailLoadVersion = 0;
  const summaryCache = createSummaryCache();

  onMount(() => {
    hideAmounts = localStorage.getItem('borton-hide-amounts') === '1';
    const applyBrowserRoute = () => {
      const route = routeFromPath(window.location.pathname);
      routeTransactionId = route.transactionId;
      void applyView(route.view, route.transactionId);
    };
    const initialRoute = routeFromPath(window.location.pathname);
    view = initialRoute.view;
    routeTransactionId = initialRoute.transactionId;
    window.addEventListener('popstate', applyBrowserRoute);
    void (async () => {
      try {
        const session = await fetch('/api/session');
        if (session.ok) { csrf = (await session.json()).csrf; await loadBoot(); await loadAssistantJobs(); }
      } catch (error) { loginError = `Could not restore your session: ${error.message || 'network error'}`; }
    })();
    chatPoll = setInterval(() => { if (signedIn && chatOpen) void loadAssistantJobs(); }, 1500);
    return () => { clearInterval(chatPoll); window.removeEventListener('popstate', applyBrowserRoute); };
  });
  $: accounts = boot?.accounts || [];
  $: categories = boot?.categories || [];
  const chartColors = ['#176b4d', '#3d8f70', '#76b795', '#d2a74c', '#c66a4a', '#7e89bb'];
  $: money = (cents) => hideAmounts ? '••••' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: boot?.currency || 'CAD' }).format((cents || 0) / 100);
  $: categoryChart = makeCategoryChart(summaryData?.byCategory || []);
  $: monthChart = [...(summaryData?.monthCategories || [])].sort((left, right) => left.name.localeCompare(right.name));
  $: monthMaximum = Math.max(...monthChart.map((row) => row.amountCents), 1);
  $: categoryColorMap = new Map((summaryData?.byCategory || []).map((row, index) => [row.id, chartColors[index % chartColors.length]]));

  function makeCategoryChart(rows) {
    const top = rows.slice(0, 5); const remainder = rows.slice(5).reduce((total, row) => total + row.amountCents, 0);
    return remainder ? [...top, { name: 'Other', amountCents: remainder, count: 0, filters: null }] : top;
  }

  function categoryGradient(rows) {
    const total = rows.reduce((sum, row) => sum + row.amountCents, 0) || 1; let start = 0;
    return `conic-gradient(${rows.map((row, index) => { const end = start + (row.amountCents / total) * 100; const slice = `${chartColors[index % chartColors.length]} ${start}% ${end}%`; start = end; return slice; }).join(', ')})`;
  }

  function monthHeight(amount) { return Math.max(8, Math.round((amount / monthMaximum) * 100)); }
  function monthLabel(month) { return new Intl.DateTimeFormat('en-CA', { month: 'short' }).format(new Date(`${month}-15T12:00:00Z`)); }
  function monthLongLabel(month) { return new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00Z`)); }
  function periodLabel(period) { return period === 'all' ? 'All time' : period === '365' ? 'Last 12 months' : `Last ${period} days`; }
  function categoryColor(row) { return categoryColorMap.get(row.id) || '#7e89bb'; }

  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${date.year}-${date.month}-${date.day}`;
  }

  async function loadBoot() {
    const data = await request('/api/bootstrap', { csrf });
    boot = data;
    transactions = data.transactions; recentUpdatedAt = new Date();
    signedIn = true;
    await applyView(view, routeTransactionId);
  }

  async function signIn() {
    loginError = '';
    try {
      const response = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginPassword }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      csrf = data.csrf; await loadBoot(); await loadAssistantJobs();
    } catch (error) { loginError = error.message; }
  }

  async function logout() {
    try { await request('/logout', { csrf, method: 'POST', body: {} }); } catch { /* Clear the local session state even if the browser already lost the cookie. */ }
    signedIn = false;
    csrf = '';
    boot = null;
    loginPassword = '';
    loginError = '';
    chatOpen = false;
    assistantJobs = [];
  }

  function show(next, { transactionId = '', replace = false } = {}) {
    routeTransactionId = transactionId;
    const path = pathForRoute(next, transactionId);
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
    void applyView(next, transactionId);
  }

  async function applyView(next, transactionId = '') {
    view = next;
    routeTransactionId = transactionId;
    summaryDetail = null;
    highlightedTransactionId = '';
    if (!signedIn) return;
    if (next === 'home' && transactionId) await openTransaction(transactionId);
    if (next === 'summary') await loadSummary();
    if (next === 'shared') await loadShared();
  }

  async function openTransaction(transactionId) {
    const rows = await request(`/api/transactions?transactionId=${encodeURIComponent(transactionId)}`, { csrf });
    transactions = rows;
    highlightedTransactionId = transactionId;
    await tick();
    document.getElementById(`transaction-${transactionId}`)?.scrollIntoView({ block: 'center' });
  }

  async function loadShared() {
    sharedData = await request('/api/shared', { csrf });
  }

  function balanceLabel(person) { return person.balanceCents >= 0 ? `${person.name} owes you` : `You owe ${person.name}`; }
  function entryLabel(entry) { return entry.direction === 'they_owe_you' ? 'They owe you' : 'You owe them'; }
  function splitSummary(row) {
    if (row.sharedDebt) return row.sharedDebt;
    if (row.debt) return row.debt;
    const details = row.splitDetails || [];
    if (!details.length) return null;
    const people = [...new Set(details.map((detail) => detail.person))];
    const accounts = [...new Set(details.map((detail) => detail.account))];
    return { person: people.join(', '), account: accounts.join(', '), amountCents: details.reduce((total, detail) => total + detail.amountCents, 0), direction: 'they_owe_you' };
  }

  function toggleAmounts() {
    hideAmounts = !hideAmounts;
    localStorage.setItem('borton-hide-amounts', hideAmounts ? '1' : '0');
  }

  async function searchTransactions() {
    transactions = await request(`/api/transactions?query=${encodeURIComponent(search)}`, { csrf });
  }

  function toggleSort(key) {
    tableSort = { key, direction: tableSort.key === key && tableSort.direction === 'asc' ? 'desc' : 'asc' };
  }

  function sortIndicator(key) { return tableSort.key === key ? tableSort.direction === 'asc' ? '↑' : '↓' : ''; }

  function filteredRows(rows) {
    const matches = (value, filter) => String(value || '').toLowerCase().includes(filter.trim().toLowerCase());
    const amountMatches = (cents, filter) => !filter.trim() || (Math.abs(cents || 0) / 100).toFixed(2).includes(filter.replace(/[^0-9.]/g, ''));
    const rowsMatching = rows.filter((row) => matches(row.date, tableFilters.date) && matches(row.merchant, tableFilters.merchant) && matches(row.account, tableFilters.account) && matches(row.category, tableFilters.category) && amountMatches(row.amountCents, tableFilters.amount));
    return [...rowsMatching].sort((left, right) => {
      const values = tableSort.key === 'amount' ? [left.amountCents || 0, right.amountCents || 0] : [String(left[tableSort.key] || '').toLowerCase(), String(right[tableSort.key] || '').toLowerCase()];
      const order = values[0] < values[1] ? -1 : values[0] > values[1] ? 1 : 0;
      return tableSort.direction === 'asc' ? order : -order;
    });
  }

  async function editTransaction(row, field = 'merchant', source = 'home') {
    editingId = row.id;
    editSource = source;
    editError = '';
    edit = { id: row.id, date: row.date, merchant: row.merchant, amount: (row.amountCents / 100).toFixed(2), account: itemName(accounts, row.accountId), category: itemName(categories, row.categoryId), note: row.note || '', splitTransactionIds: row.splitTransactionIds || [], hasSharedDebt: Boolean(row.debt || row.sharedDebt || row.splitDetails?.length) };
    await tick();
    document.getElementById(`edit-${row.id}-${field}`)?.focus();
  }

  function splitOwner() {
    return matchItem(accounts, edit?.account)?.owner || '';
  }

  async function beginSplit(row) {
    if (row.debt || row.sharedDebt || row.splitDetails?.length) return;
    await editTransaction(row, 'amount', view === 'summary' ? 'summary' : 'home');
    startSplit();
  }

  function startSplit() {
    const owner = splitOwner();
    splittingId = edit.id;
    splitMode = 'equal';
    splitPerson = owner;
    splitShares = [{ person: owner, value: '' }];
    editError = '';
  }

  function cancelSplit() {
    splittingId = null;
    splitPerson = '';
    splitMode = 'equal';
    splitShares = [{ person: '', value: '' }];
  }

  function addSplitPerson() {
    splitShares = [...splitShares, { person: '', value: '' }];
  }

  function removeSplitPerson(index) {
    splitShares = splitShares.filter((_, current) => current !== index);
  }

  function splitPreview() {
    const totalCents = Math.round(Number(edit?.amount) * 100);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return null;
    const owner = splitOwner();
    const people = splitShares.filter((share) => share.person.trim());
    if (splitMode === 'equal') {
      if (owner) return { sharedCents: Math.round(totalCents / 2), ownCents: totalCents - Math.round(totalCents / 2), yourCents: Math.round(totalCents / 2) };
      if (!people.length) return null;
      const each = Math.round(totalCents / (people.length + 1));
      return { sharedCents: each * people.length, ownCents: totalCents - each * people.length, yourCents: totalCents - each * people.length };
    }
    const sharedCents = people.reduce((total, share) => {
      const value = Number(share.value);
      return total + (Number.isFinite(value) && value > 0 ? splitMode === 'amount' ? Math.round(value * 100) : Math.round(totalCents * value / 100) : 0);
    }, 0);
    return { sharedCents, ownCents: totalCents - sharedCents, yourCents: owner ? sharedCents : totalCents - sharedCents };
  }

  function splitDirection() {
    const owner = splitOwner();
    if (owner) return `You owe ${owner}`;
    const people = splitShares.map((share) => share.person.trim()).filter(Boolean);
    return people.length ? `${people.join(', ')} ${people.length === 1 ? 'owes' : 'owe'} you` : 'They owe you';
  }

  function cancelEdit({ keepSplit = false } = {}) {
    editingId = null;
    edit = null;
    editError = '';
    editSource = '';
    if (!keepSplit) cancelSplit();
  }

  async function refreshSummaryAfterEdit() {
    const data = await request(`/api/summary?period=${summaryPeriod}&force=true`, { csrf });
    summaryData = data;
    summaryCache.set(summaryPeriod, data);
    summaryUpdatedAt = new Date();
    await updateSummaryDetail(true);
  }

  function handleEditShortcut(event) {
    if (!editingId || !edit || savingEdit || event.isComposing || event.target?.closest?.('button')) return;
    if (!event.target?.closest?.('tr.editing')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void saveEdit();
    }
  }

  async function refreshTransactionsAfterEdit(source) {
    if (source === 'summary') await refreshSummaryAfterEdit();
    else if (search) await searchTransactions();
    else {
      const data = await request('/api/bootstrap', { csrf });
      boot = data; transactions = data.transactions; recentUpdatedAt = new Date();
    }
  }

  function showNotice(notice, duration = 5000) {
    editNotice = notice;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { editNotice = null; }, duration);
  }

  function showSavedNotice(saved) {
    const date = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${saved.date}T12:00:00`));
    showNotice({ text: `Saved ${saved.merchant} · ${money(saved.amountCents)} · ${saved.category} · ${date}`, transactionId: saved.id });
  }

  function viewSavedTransaction() {
    if (!editNotice?.transactionId) return;
    show('home', { transactionId: editNotice.transactionId });
    editNotice = null;
  }

  async function saveEdit({ refresh = true, notice = true, keepSplit = false } = {}) {
    if (!edit || savingEdit) return null;
    const accountId = matchItem(accounts, edit.account)?.id;
    const categoryId = matchItem(categories, edit.category)?.id;
    const amountCents = Math.round(Number(edit.amount) * 100);
    if (!accountId || !categoryId || !edit.merchant.trim() || !Number.isSafeInteger(amountCents) || amountCents <= 0) { editError = 'Complete the highlighted fields with an account and category from the suggestions.'; return null; }
    savingEdit = true;
    try {
      const savedMerchant = edit.merchant.trim();
      await request('/api/transactions/edit', { csrf, method: 'POST', body: { id: edit.id, merchant: savedMerchant, amountCents, date: edit.date, accountId, categoryId, note: edit.note, splitTransactionIds: edit.splitTransactionIds } });
      const saved = { id: edit.id, date: edit.date, accountId, source: editSource, merchant: savedMerchant, category: edit.category, amountCents };
      summaryCache.clear();
      if (!keepSplit) cancelEdit();
      if (refresh) await refreshTransactionsAfterEdit(saved.source);
      if (notice) showSavedNotice(saved);
      return saved;
    } catch (error) { editError = error.message; }
    finally { savingEdit = false; }
  }

  async function saveSplit() {
    const owner = splitOwner();
    const shares = owner ? [{ person: owner, value: splitShares[0]?.value || '' }] : splitShares.map((share) => ({ person: share.person.trim(), value: share.value }));
    if (!owner && shares.some((share) => !share.person)) { editError = 'Enter a person for every share.'; return; }
    const preview = splitPreview();
    if (!preview || preview.yourCents <= 0 || (!owner && preview.ownCents <= 0)) { editError = owner ? 'Enter your share.' : 'Leave an amount for your share.'; return; }
    const saved = await saveEdit({ refresh: false, notice: false, keepSplit: true });
    if (!saved) return;
    try {
      const result = await request('/api/transactions/split', { csrf, method: 'POST', body: { id: saved.id, date: saved.date, accountId: saved.accountId, mode: splitMode, shares } });
      summaryCache.clear();
      await refreshTransactionsAfterEdit(saved.source);
      const names = (result.shares || [{ person: result.person }]).map((share) => share.person).filter(Boolean).join(', ') || 'your contact';
      cancelEdit();
      showNotice({ text: result.direction === 'you_owe_them' ? `Split saved · You owe ${names}.` : `Split saved · ${names} owe you.` }, 3500);
    } catch (error) {
      editError = error.message;
    }
  }

  function hydrate(rows) {
    return rows.map((row) => ({ ...row, amount: (row.amountCents / 100).toFixed(2), account: itemName(accounts, row.accountId), category: itemName(categories, row.categoryId) }));
  }

  function rowsForSave(rows) {
    return rows.map((row) => ({ ...row, amountCents: Math.round(Number(row.amount) * 100), accountId: matchItem(accounts, row.account)?.id || '', categoryId: matchItem(categories, row.category)?.id || '' }));
  }

  async function submitRows(rows) {
    const checked = await request('/api/batches/validate', { csrf, method: 'POST', body: { rows: rowsForSave(rows) } });
    if (checked.rows.some((row) => row.status !== 'ready')) { batch = hydrate(checked.rows); show('add'); return false; }
    const result = await request('/api/batches/submit', { csrf, method: 'POST', body: { requestId: crypto.randomUUID(), rows: checked.rows } });
    if (result.status !== 'complete') throw Error(result.error || result.status);
    summaryCache.clear(); batch = []; quick = { merchant: '', amount: '', date: today(), account: '', category: '', note: '' }; await loadBoot(); return true;
  }

  async function addQuickExpense() {
    quickError = '';
    if (!matchItem(accounts, quick.account) || !matchItem(categories, quick.category)) { quickError = 'Choose an account and category from the suggestions.'; return; }
    try { await submitRows([{ ...quick, clientId: crypto.randomUUID(), duplicateAcknowledged: false }]); } catch (error) { quickError = error.message; }
  }

  async function saveBatch() {
    try { await submitRows(batch); } catch (error) { quickError = error.message; }
  }

  async function extractReceipt(event) {
    const image = event.currentTarget.elements.image.files[0]; if (!image) return;
    quickError = '';
    try {
      const form = new FormData(); form.append('image', image);
      const data = await request('/api/extract', { csrf, method: 'POST', form });
      batch = hydrate(data.rows); show('add');
    } catch (error) { quickError = error.message; }
  }

  async function loadSummary(force = false) {
    summaryDetail = null;
    summaryDetailFilters = null;
    hoveredMonth = null;
    let data = summaryCache.get(summaryPeriod);
    if (!data || force) { data = await request(`/api/summary?period=${summaryPeriod}${force ? '&force=true' : ''}`, { csrf }); summaryCache.set(summaryPeriod, data); }
    summaryData = data; summaryUpdatedAt = new Date();
  }

  async function openDetail(filters) {
    summaryDetailFilters = { ...filters };
    detailAccount = itemName(accounts, filters.accountId); detailCategory = itemName(categories, filters.categoryId);
    const data = await request(`/api/transactions?paged=true&limit=100&${new URLSearchParams(summaryDetailFilters)}`, { csrf });
    summaryDetail = data.rows;
  }

  async function updateSummaryDetail(force = false) {
    if (!summaryDetailFilters) return;
    const version = ++detailLoadVersion;
    const query = new URLSearchParams({ ...summaryDetailFilters, ...(force ? { force: 'true' } : {}) });
    const data = await request(`/api/transactions?paged=true&limit=100&${query}`, { csrf });
    if (version === detailLoadVersion) summaryDetail = data.rows;
  }

  function chatContext() {
    const rows = view === 'home' ? transactions : view === 'summary' && summaryDetail ? summaryDetail : [];
    return {
      page: view === 'summary' && summaryDetail ? 'Summary transaction detail' : view === 'home' ? 'Home recent expenses' : view,
      filters: view === 'summary' && summaryDetail ? summaryDetailFilters : view === 'home' && search ? { search } : {},
      visibleTransactions: rows.map((row) => ({ id: row.id, date: row.date, merchant: row.merchant, accountId: row.accountId, account: row.account, categoryId: row.categoryId || null, category: row.category || null, amountCents: row.amountCents, note: String(row.note || '').slice(0, 80) })),
    };
  }

  async function loadAssistantJobs() {
    if (!csrf) return;
    assistantJobs = await request('/api/assistant/messages', { csrf });
  }

  async function openChat(tab = 'chat') {
    chatTab = tab;
    chatOpen = true;
    try { await loadAssistantJobs(); } catch { /* The drawer can still accept a message after a transient status read failure. */ }
  }

  function queueLabel(job) {
    if (job.status === 'processing') return 'Borton is working…';
    if (job.status === 'queued') return 'Queued';
    if (job.status === 'retry') return `Retrying ${new Date(job.nextAt).toLocaleTimeString()}`;
    if (job.status === 'failed') return job.lastError || 'Could not deliver';
    return '';
  }

  async function sendChat() {
    const text = chatText.trim(); if (!text) return;
    try {
      await request('/api/assistant/message', { csrf, method: 'POST', body: { text, context: chatContext() } });
      chatText = '';
      await loadAssistantJobs();
    } catch (error) { quickError = error.message; }
  }
</script>

<svelte:window on:keydown|capture={handleEditShortcut} />

{#if !signedIn}
  <main class="login-shell">
    <section class="card login"><h1>Borton</h1><form on:submit|preventDefault={signIn}><input bind:value={loginPassword} type="password" placeholder="Password" required><button>Sign in</button>{#if loginError}<output class="error">{loginError}</output>{/if}</form></section>
  </main>
{:else}
  <main class="shell">
    <aside><h1>Borton</h1><small>Synced {new Date(boot.syncedAt).toLocaleTimeString()}</small><nav><span class="nav-heading">View</span><button class:active={view === 'home'} on:click={() => show('home')}>Home</button><button class:active={view === 'summary'} on:click={() => show('summary')}>Summary</button><button class:active={view === 'shared'} on:click={() => show('shared')}>Shared</button><span class="nav-heading">Actions</span><button class="nav-action" class:active={view === 'add'} on:click={() => show('add')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add expense</span></button><button class="nav-action" class:active={view === 'check'} on:click={() => show('check')}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg><span>Check an expense</span></button></nav></aside>
    <section class="main"><header><div class="mobile-nav"><button on:click={() => show('home')}>Home</button><button on:click={() => show('summary')}>Summary</button><button on:click={() => show('shared')}>Shared</button></div><div class="header-actions"><button class="logout-button" on:click={logout}>Log out</button><button class="queue-trigger" on:click={() => openChat('queue')} aria-label="Open message activity" title="Message activity"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg></button><button class="chat-trigger" on:click={() => openChat('chat')} aria-label="Open chat" title="Chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.2-.6L4 20l1.5-4.1A7.2 7.2 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg></button></div></header>

      {#if view === 'home'}
        <section class="card"><div class="toolbar page-toolbar"><h2>Recent expenses</h2><div class="toolbar-actions"><button class="icon-button" class:pressed={hideAmounts} on:click={toggleAmounts} aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'} title={hideAmounts ? 'Show amounts' : 'Hide amounts'}>{@html hideAmounts ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.8 10.8 0 0 1 12 4c5.2 0 8.8 5.1 9.8 8-0.4 1.1-1.2 2.6-2.5 4M6.2 6.2C4.2 7.8 2.8 10.2 2.2 12c1 2.9 4.6 8 9.8 8 1.3 0 2.5-.3 3.6-.8"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12C3.2 9.1 6.8 4 12 4s8.8 5.1 9.8 8c-1 2.9-4.6 8-9.8 8S3.2 14.9 2.2 12Z"/><circle cx="12" cy="12" r="3"/></svg>' }</button><button class="icon-button" on:click={loadBoot} aria-label="Refresh recent expenses" title={`Updated ${new Date(boot.syncedAt).toLocaleString()}`}>↻</button>{#if recentUpdatedAt}<small class="updated">Updated {recentUpdatedAt.toLocaleString()}</small>{/if}</div></div>
          <section class="quick-add"><form on:submit|preventDefault={addQuickExpense}><div class="quick-add-heading"><h3>Quick add</h3><button>Add expense</button></div><div class="quick-fields"><label>Merchant<input bind:value={quick.merchant} placeholder="Merchant" required></label><label>Amount<input bind:value={quick.amount} placeholder="Amount" inputmode="decimal" required></label><label>Date<input bind:value={quick.date} type="date" required></label><Picker label="Paid from" items={accounts} bind:value={quick.account} placeholder="Search accounts" required /><Picker label="Category" items={categories} bind:value={quick.category} placeholder="Search categories" required /></div><details class="quick-note"><summary>Add note</summary><label>Notes<textarea bind:value={quick.note} rows="2" placeholder="What was this for?"></textarea><DictationButton bind:value={quick.note} {csrf} /></label></details>{#if quickError}<output class="error">{quickError}</output>{/if}</form></section>
          <div class="toolbar search-bar"><input bind:value={search} placeholder="Search merchant or notes"><button on:click={searchTransactions}>Search</button></div>
          <table class="transactions"><thead><tr><th><button class="column-sort" on:click={() => toggleSort('date')}>Date {sortIndicator('date')}</button></th><th><button class="column-sort" on:click={() => toggleSort('merchant')}>Merchant {sortIndicator('merchant')}</button></th><th><button class="column-sort" on:click={() => toggleSort('account')}>Account {sortIndicator('account')}</button></th><th><button class="column-sort" on:click={() => toggleSort('category')}>Category {sortIndicator('category')}</button></th><th>Notes</th><th class="amount"><button class="column-sort" on:click={() => toggleSort('amount')}>Amount {sortIndicator('amount')}</button></th><th class="row-actions"><span class="sr-only">Save or cancel</span></th></tr><tr class="column-filters"><th><input bind:value={tableFilters.date} aria-label="Filter date" placeholder="Filter"></th><th><input bind:value={tableFilters.merchant} aria-label="Filter merchant" placeholder="Filter"></th><th><input bind:value={tableFilters.account} aria-label="Filter account" placeholder="Filter"></th><th><input bind:value={tableFilters.category} aria-label="Filter category" placeholder="Filter"></th><th></th><th><input bind:value={tableFilters.amount} aria-label="Filter amount" placeholder="Filter"></th><th></th></tr></thead><tbody>{#each filteredRows(transactions) as row}<tr id={`transaction-${row.id}`} class:editing={editingId === row.id} class:highlighted={highlightedTransactionId === row.id}>{#if editingId === row.id}<td><input id={`edit-${row.id}-date`} bind:value={edit.date} type="date" aria-label="Date"></td><td><input id={`edit-${row.id}-merchant`} bind:value={edit.merchant} aria-label="Merchant"></td><td><Picker label="" inputId={`edit-${row.id}-account`} items={accounts} bind:value={edit.account} placeholder="Account" /></td><td><Picker label="" inputId={`edit-${row.id}-category`} items={categories} bind:value={edit.category} placeholder="Category" /></td><td><textarea id={`edit-${row.id}-note`} bind:value={edit.note} rows="2" aria-label="Notes"></textarea></td><td class="amount"><input id={`edit-${row.id}-amount`} bind:value={edit.amount} inputmode="decimal" aria-label="Amount"></td><td class="edit-actions">{#if edit.hasSharedDebt}<button class="table-icon secondary" disabled title="Already a shared expense" aria-label="Already a shared expense">÷</button>{:else}<button class="table-icon secondary" on:click={startSplit} disabled={savingEdit} title="Convert to shared expense" aria-label="Convert to shared expense">÷</button>{/if}<button class="table-icon" on:click={saveEdit} disabled={savingEdit} title="Save changes" aria-label="Save changes">✓</button><button class="table-icon secondary" on:click={cancelEdit} title="Cancel editing" aria-label="Cancel editing">×</button></td>{:else}<td><button class="cell-edit" on:click={() => editTransaction(row, 'date')}>{row.date}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'merchant')}>{row.merchant}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'account')}>{row.account}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'category')} aria-label={`Edit category${row.category ? `: ${row.category}` : ' (empty)'}`}>{row.category || ''}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'note')}>{row.note || '—'}</button></td><td class="amount"><button class="cell-edit" on:click={() => editTransaction(row, 'amount')}>{#if row.splitDetails?.length || row.sharedDebt}<small class="split-total">Total</small>{/if}{money(row.amountCents)}</button></td><td class="row-actions">{#if !splitSummary(row)}<button class="row-split" on:click={() => beginSplit(row)} aria-label="Split this expense" title="Split this expense">÷</button>{/if}</td>{/if}</tr>{#if editingId === row.id && editError}<tr class="edit-error"><td colspan="7"><output class="error">{editError}</output></td></tr>{/if}{#if splittingId === row.id}{@const preview = splitPreview()}<tr class="split-editor"><td colspan="7"><div><strong>{splitDirection()}</strong><div class="split-mode" role="group" aria-label="Split method"><button class:pressed={splitMode === 'equal'} class="secondary" on:click={() => splitMode = 'equal'}>Equal</button><button class:pressed={splitMode === 'amount'} class="secondary" on:click={() => splitMode = 'amount'}>$</button><button class:pressed={splitMode === 'percent'} class="secondary" on:click={() => splitMode = 'percent'}>%</button></div>{#if splitOwner()}<label class="split-value">{splitMode === 'equal' ? 'Your share' : splitMode === 'amount' ? 'Your amount' : 'Your %'}{#if splitMode !== 'equal'}<input bind:value={splitShares[0].value} inputmode="decimal" placeholder={splitMode === 'amount' ? '0.00' : '0'} aria-label="Your share">{/if}</label>{:else}<div class="split-people">{#each splitShares as share, index}<div><input bind:value={share.person} placeholder="Name" aria-label="Person sharing this expense">{#if splitMode !== 'equal'}<input bind:value={share.value} inputmode="decimal" placeholder={splitMode === 'amount' ? '0.00' : '0'} aria-label="Share amount">{/if}{#if splitShares.length > 1}<button class="secondary split-remove" on:click={() => removeSplitPerson(index)} aria-label="Remove {share.person || 'person'}">×</button>{/if}</div>{/each}<button class="secondary split-add" on:click={addSplitPerson}>+ Person</button></div>{/if}{#if preview}<small>You: {money(preview.yourCents)}</small>{/if}<button on:click={saveSplit} disabled={savingEdit}>Split</button><button class="secondary" on:click={cancelSplit} aria-label="Cancel split">Cancel</button></div></td></tr>{/if}{#if splitSummary(row) && editingId !== row.id}{@const sharing = splitSummary(row)}<tr class:negative={sharing.direction === 'you_owe_them'} class="split-line split-summary"><td></td><td colspan="2"><span class="split-label">↳ {sharing.direction === 'they_owe_you' ? `${sharing.person} owes you` : `You owe ${sharing.person}`}</span></td><td><span>{sharing.account}</span></td><td></td><td class="amount">{money(sharing.amountCents)}</td><td></td></tr>{/if}{:else}<tr><td colspan="7" class="muted">No transactions found.</td></tr>{/each}</tbody></table>
        </section>
      {:else if view === 'summary'}
        <section class="card"><div class="toolbar page-toolbar">{#if summaryDetail}<button class="back-title" on:click={() => { summaryDetail = null; summaryDetailFilters = null; }} aria-label="Back to summary">← <span>Summary</span></button>{:else}<h2>Summary</h2>{/if}<div class="toolbar-actions"><button class="icon-button" class:pressed={hideAmounts} on:click={toggleAmounts} aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'} title={hideAmounts ? 'Show amounts' : 'Hide amounts'}>{@html hideAmounts ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.8 10.8 0 0 1 12 4c5.2 0 8.8 5.1 9.8 8-0.4 1.1-1.2 2.6-2.5 4M6.2 6.2C4.2 7.8 2.8 10.2 2.2 12c1 2.9 4.6 8 9.8 8 1.3 0 2.5-.3 3.6-.8"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12C3.2 9.1 6.8 4 12 4s8.8 5.1 9.8 8c-1 2.9-4.6 8-9.8 8S3.2 14.9 2.2 12Z"/><circle cx="12" cy="12" r="3"/></svg>' }</button><button class="icon-button" on:click={() => loadSummary(true)} aria-label="Refresh summary" title={summaryUpdatedAt ? `Updated ${summaryUpdatedAt.toLocaleString()}` : 'Refresh summary'}>↻</button>{#if summaryUpdatedAt}<small class="updated">Updated {summaryUpdatedAt.toLocaleString()}</small>{/if}</div></div>
          {#if summaryDetail}<div class="summary-detail-heading"><label>From<input bind:value={summaryDetailFilters.start} type="date" on:change={updateSummaryDetail}></label><label>To<input bind:value={summaryDetailFilters.end} type="date" on:change={updateSummaryDetail}></label><Picker label="Account" items={accounts} bind:value={detailAccount} placeholder="All accounts" on:change={() => { summaryDetailFilters.accountId = matchItem(accounts, detailAccount)?.id || ''; updateSummaryDetail(); }} /><Picker label="Category" items={categories} bind:value={detailCategory} placeholder="All categories" on:change={() => { summaryDetailFilters.categoryId = matchItem(categories, detailCategory)?.id || ''; updateSummaryDetail(); }} /><button class="secondary" on:click={updateSummaryDetail}>Apply</button></div><table class="transactions"><thead><tr><th><button class="column-sort" on:click={() => toggleSort('date')}>Date {sortIndicator('date')}</button></th><th><button class="column-sort" on:click={() => toggleSort('merchant')}>Merchant {sortIndicator('merchant')}</button></th><th><button class="column-sort" on:click={() => toggleSort('account')}>Account {sortIndicator('account')}</button></th><th><button class="column-sort" on:click={() => toggleSort('category')}>Category {sortIndicator('category')}</button></th><th>Notes</th><th class="amount"><button class="column-sort" on:click={() => toggleSort('amount')}>Amount {sortIndicator('amount')}</button></th><th class="row-actions"><span class="sr-only">Save or cancel</span></th></tr><tr class="column-filters"><th><input bind:value={tableFilters.date} aria-label="Filter date" placeholder="Filter"></th><th><input bind:value={tableFilters.merchant} aria-label="Filter merchant" placeholder="Filter"></th><th><input bind:value={tableFilters.account} aria-label="Filter account" placeholder="Filter"></th><th><input bind:value={tableFilters.category} aria-label="Filter category" placeholder="Filter"></th><th></th><th><input bind:value={tableFilters.amount} aria-label="Filter amount" placeholder="Filter"></th><th></th></tr></thead><tbody>{#each filteredRows(summaryDetail) as row}<tr id={`transaction-${row.id}`} class:editing={editingId === row.id} class:highlighted={highlightedTransactionId === row.id}>{#if editingId === row.id}<td><input id={`edit-${row.id}-date`} bind:value={edit.date} type="date" aria-label="Date"></td><td><input id={`edit-${row.id}-merchant`} bind:value={edit.merchant} aria-label="Merchant"></td><td><Picker label="" inputId={`edit-${row.id}-account`} items={accounts} bind:value={edit.account} placeholder="Account" /></td><td><Picker label="" inputId={`edit-${row.id}-category`} items={categories} bind:value={edit.category} placeholder="Category" /></td><td><textarea id={`edit-${row.id}-note`} bind:value={edit.note} rows="2" aria-label="Notes"></textarea></td><td class="amount"><input id={`edit-${row.id}-amount`} bind:value={edit.amount} inputmode="decimal" aria-label="Amount"></td><td class="edit-actions">{#if edit.hasSharedDebt}<button class="table-icon secondary" disabled title="Already a shared expense" aria-label="Already a shared expense">÷</button>{:else}<button class="table-icon secondary" on:click={startSplit} disabled={savingEdit} title="Convert to shared expense" aria-label="Convert to shared expense">÷</button>{/if}<button class="table-icon" on:click={saveEdit} disabled={savingEdit} title="Save changes" aria-label="Save changes">✓</button><button class="table-icon secondary" on:click={cancelEdit} title="Cancel editing" aria-label="Cancel editing">×</button></td>{:else}<td><button class="cell-edit" on:click={() => editTransaction(row, 'date', 'summary')}>{row.date}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'merchant', 'summary')}>{row.merchant}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'account', 'summary')}>{row.account}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'category', 'summary')} aria-label={`Edit category${row.category ? `: ${row.category}` : ' (empty)'}`}>{row.category || ''}</button></td><td><button class="cell-edit" on:click={() => editTransaction(row, 'note', 'summary')}>{row.note || '—'}</button></td><td class="amount"><button class="cell-edit" on:click={() => editTransaction(row, 'amount', 'summary')}>{#if row.splitDetails?.length || row.sharedDebt}<small class="split-total">Total</small>{/if}{money(row.amountCents)}</button></td><td class="row-actions">{#if !splitSummary(row)}<button class="row-split" on:click={() => beginSplit(row)} aria-label="Split this expense" title="Split this expense">÷</button>{/if}</td>{/if}</tr>{#if editingId === row.id && editError}<tr class="edit-error"><td colspan="7"><output class="error">{editError}</output></td></tr>{/if}{#if splittingId === row.id}{@const preview = splitPreview()}<tr class="split-editor"><td colspan="7"><div><strong>{splitDirection()}</strong><div class="split-mode" role="group" aria-label="Split method"><button class:pressed={splitMode === 'equal'} class="secondary" on:click={() => splitMode = 'equal'}>Equal</button><button class:pressed={splitMode === 'amount'} class="secondary" on:click={() => splitMode = 'amount'}>$</button><button class:pressed={splitMode === 'percent'} class="secondary" on:click={() => splitMode = 'percent'}>%</button></div>{#if splitOwner()}<label class="split-value">{splitMode === 'equal' ? 'Your share' : splitMode === 'amount' ? 'Your amount' : 'Your %'}{#if splitMode !== 'equal'}<input bind:value={splitShares[0].value} inputmode="decimal" placeholder={splitMode === 'amount' ? '0.00' : '0'} aria-label="Your share">{/if}</label>{:else}<div class="split-people">{#each splitShares as share, index}<div><input bind:value={share.person} placeholder="Name" aria-label="Person sharing this expense">{#if splitMode !== 'equal'}<input bind:value={share.value} inputmode="decimal" placeholder={splitMode === 'amount' ? '0.00' : '0'} aria-label="Share amount">{/if}{#if splitShares.length > 1}<button class="secondary split-remove" on:click={() => removeSplitPerson(index)} aria-label="Remove {share.person || 'person'}">×</button>{/if}</div>{/each}<button class="secondary split-add" on:click={addSplitPerson}>+ Person</button></div>{/if}{#if preview}<small>You: {money(preview.yourCents)}</small>{/if}<button on:click={saveSplit} disabled={savingEdit}>Split</button><button class="secondary" on:click={cancelSplit} aria-label="Cancel split">Cancel</button></div></td></tr>{/if}{#if splitSummary(row) && editingId !== row.id}{@const sharing = splitSummary(row)}<tr class:negative={sharing.direction === 'you_owe_them'} class="split-line split-summary"><td></td><td colspan="2"><span class="split-label">↳ {sharing.direction === 'they_owe_you' ? `${sharing.person} owes you` : `You owe ${sharing.person}`}</span></td><td><span>{sharing.account}</span></td><td></td><td class="amount">{money(sharing.amountCents)}</td><td></td></tr>{/if}{:else}<tr><td colspan="7" class="muted">No transactions found.</td></tr>{/each}</tbody></table>{:else if summaryData}<div class="summary-period"><label>Period<select bind:value={summaryPeriod} on:change={() => loadSummary()}><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option><option value="all">All time</option></select></label></div><div class="summary-total"><span>{periodLabel(summaryData.period)} · {summaryData.start} to {summaryData.end}</span><strong>{money(summaryData.totalCents)}</strong><small>{summaryData.count} expenses</small></div><section class="summary-visuals"><article class="chart-card"><div><h3>Spending by category</h3><p class="muted">Tap a category to view its expenses.</p></div><div class="donut-wrap"><div class="donut" style={`background:${categoryGradient(categoryChart)}`}><strong>{money(summaryData.totalCents)}</strong><small>Total</small></div><ol class="chart-legend">{#each categoryChart as row, index}<li><button disabled={!row.filters} on:click={() => row.filters && openDetail(row.filters)}><i style={`background:${chartColors[index % chartColors.length]}`}></i><span>{row.name}</span><strong>{money(row.amountCents)}</strong></button></li>{/each}</ol></div></article><article class="chart-card month-chart"><div><h3>Monthly spending</h3><p class="muted">Hover a bar to see its categories, or tap it to view the month.</p></div><div class="bars">{#each monthChart as row}<div class="bar-hover"><button aria-label={`${monthLongLabel(row.name)}: ${money(row.amountCents)}`} on:mouseenter={() => hoveredMonth = row} on:mouseleave={() => hoveredMonth = null} on:focus={() => hoveredMonth = row} on:blur={() => hoveredMonth = null} on:click={() => openDetail(row.filters)}><span class="bar stack" style={`height:${monthHeight(row.amountCents)}%`}>{#each row.categories as category}<i aria-label={`${category.name}: ${money(category.amountCents)}`} style={`background:${categoryColor(category)};flex:${category.amountCents}`}></i>{/each}</span><small>{monthLabel(row.name)}</small></button>{#if hoveredMonth?.name === row.name}<section class="month-tooltip"><div><strong>{monthLongLabel(row.name)}</strong><span>{money(row.amountCents)}</span></div><ol>{#each row.categories as category}<li><i style={`background:${categoryColor(category)}`}></i><span>{category.name}</span><strong>{money(category.amountCents)}</strong></li>{/each}</ol></section>{/if}</div>{/each}</div></article></section><div class="breakdown-grid">{#each [['Category', summaryData.byCategory], ['Account', summaryData.byAccount], ['Month', summaryData.byMonth]] as [title, rows]}<article><h3>{title}</h3><ol>{#each rows as row}<li><button on:click={() => openDetail(row.filters)}><span>{row.name} <small>({row.count})</small></span><strong>{money(row.amountCents)}</strong></button></li>{/each}</ol></article>{/each}</div>{:else}<p class="muted">Loading…</p>{/if}
        </section>
      {:else if view === 'shared'}
        <section class="card shared-page"><div class="toolbar page-toolbar"><h2>Shared expenses</h2><div class="toolbar-actions"><button class="icon-button" class:pressed={hideAmounts} on:click={toggleAmounts} aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'} title={hideAmounts ? 'Show amounts' : 'Hide amounts'}>◉</button><button class="icon-button" on:click={loadShared} aria-label="Refresh shared expenses" title="Refresh shared expenses">↻</button></div></div>{#if sharedData?.people?.length}<div class="shared-grid">{#each sharedData.people as person}<article class="shared-person"><header><div><h3>{person.name}</h3><small>{balanceLabel(person)}</small></div><strong class:negative={person.balanceCents < 0}>{money(Math.abs(person.balanceCents))}</strong></header><ol>{#each person.entries as entry}<li><div><strong>{entry.merchant || 'Settlement'}</strong><small>{entry.date}{#if entry.note} · {entry.note}{/if}</small></div><div><span class:negative={entry.direction === 'you_owe_them'}>{entryLabel(entry)} · {money(entry.amountCents)}</span><small>Balance: {money(Math.abs(entry.runningBalanceCents))} {entry.runningBalanceCents >= 0 ? 'owed to you' : 'you owe'}</small></div></li>{/each}</ol></article>{/each}</div>{:else if sharedData}<p class="muted">No shared balances yet.</p>{:else}<p class="muted">Loading shared expenses…</p>{/if}</section>
      {:else if view === 'add'}
        <section class="card"><h2>Review expenses</h2>{#if batch.length}<section class="batch">{#each batch as row, index (row.clientId)}<article class="receipt"><label>Merchant<input bind:value={row.merchant}></label><label>Amount<input bind:value={row.amount} inputmode="decimal"></label><label>Date<input bind:value={row.date} type="date"></label><Picker label="Paid from" items={accounts} bind:value={row.account} placeholder="Search accounts" /><Picker label="Category" items={categories} bind:value={row.category} placeholder="Search categories" /><label class="receipt-note">Notes<textarea bind:value={row.note} rows="2"></textarea><DictationButton bind:value={row.note} {csrf} /></label>{#if row.duplicates?.length}<label class="duplicate-choice">Likely duplicate <input bind:checked={row.duplicateAcknowledged} type="checkbox"> intentionally new</label>{/if}</article>{/each}</section><button on:click={saveBatch}>Save expenses</button>{#if quickError}<output class="error">{quickError}</output>{/if}{:else}<p class="muted">Use Check an expense to upload a receipt, or add one from Home.</p>{/if}</section>
      {:else if view === 'check'}
        <section class="card"><h2>Check an expense</h2><p>Upload a receipt or ask Chat when you only remember part of it.</p><form on:submit|preventDefault={extractReceipt}><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" required><button>Read receipt</button>{#if quickError}<output class="error">{quickError}</output>{/if}</form><details><summary>Enter known details</summary><button on:click={() => openChat('chat')}>Ask in Chat</button></details></section>
      {/if}
    </section>
    {#if editNotice}<aside class="edit-notice" role="status"><span>{editNotice.text}</span>{#if editNotice.transactionId}<button class="secondary" on:click={viewSavedTransaction}>View transaction</button>{/if}</aside>{/if}
    {#if chatOpen}<button class="chat-scrim" aria-label="Close chat" on:click={() => chatOpen = false}></button><section class="chat" aria-label="Borton chat"><header class="chat-header"><div><strong>Borton</strong><small>Private budget assistant</small></div><button class="chat-close" on:click={() => chatOpen = false} aria-label="Close chat">×</button></header><nav class="chat-tabs"><button class:active={chatTab === 'chat'} on:click={() => chatTab = 'chat'}>Chat</button><button class:active={chatTab === 'queue'} on:click={() => chatTab = 'queue'}>Activity{#if assistantJobs.filter((job) => ['queued', 'processing', 'retry'].includes(job.status)).length}<span>{assistantJobs.filter((job) => ['queued', 'processing', 'retry'].includes(job.status)).length}</span>{/if}</button></nav>{#if chatTab === 'chat'}<div class="messages">{#each [...assistantJobs].reverse() as job}<article class="chat-thread"><div class="message user">{job.text}</div>{#if job.status === 'complete'}<div class="message assistant">{job.response}</div>{:else}<small class:failed={job.status === 'failed'} class="message-status">{queueLabel(job)}</small>{/if}</article>{:else}<div class="chat-empty"><strong>Ask Borton anything</strong><span>It can check receipts, find duplicates, and stage bulk changes for confirmation.</span></div>{/each}</div><form class="chat-composer" on:submit|preventDefault={sendChat}><textarea bind:value={chatText} rows="1" placeholder="Message Borton" on:keydown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat(); } }}></textarea><button aria-label="Send message" title="Send">↑</button></form>{:else}<div class="message-activity">{#each assistantJobs as job}<article><div><strong>{job.status === 'complete' ? 'Delivered' : queueLabel(job)}</strong><small>{new Date(job.createdAt).toLocaleString()}</small></div><p>{job.text}</p>{#if job.response}<p class="activity-response">{job.response}</p>{/if}</article>{:else}<div class="chat-empty"><strong>No message activity yet</strong><span>Queued and completed web messages will appear here.</span></div>{/each}</div>{/if}</section>{/if}
  </main>
{/if}
