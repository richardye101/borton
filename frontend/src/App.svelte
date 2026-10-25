<script>
  import { onMount } from 'svelte';
  import { request } from './lib/api.js';
  import { createSummaryCache } from './lib/client-state.js';
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
  let messages = [];
  let chatOpen = false;
  let chatText = '';
  let hideAmounts = false;
  let summaryPeriod = '90';
  let summaryData = null;
  let summaryDetail = null;
  let summaryDetailFilters = null;
  let summaryUpdatedAt = null;
  let recentUpdatedAt = null;
  let detailAccount = '';
  let detailCategory = '';
  let hoveredMonth = null;
  const summaryCache = createSummaryCache();

  onMount(async () => {
    hideAmounts = localStorage.getItem('borton-hide-amounts') === '1';
    try {
      const session = await fetch('/api/session');
      if (session.ok) { csrf = (await session.json()).csrf; await loadBoot(); }
    } catch (error) { loginError = `Could not restore your session: ${error.message || 'network error'}`; }
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
    show(view);
  }

  async function signIn() {
    loginError = '';
    try {
      const response = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginPassword }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      csrf = data.csrf; await loadBoot();
    } catch (error) { loginError = error.message; }
  }

  function show(next) {
    view = next;
    summaryDetail = null;
    if (next === 'summary') loadSummary();
  }

  function toggleAmounts() {
    hideAmounts = !hideAmounts;
    localStorage.setItem('borton-hide-amounts', hideAmounts ? '1' : '0');
  }

  async function searchTransactions() {
    transactions = await request(`/api/transactions?query=${encodeURIComponent(search)}`, { csrf });
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

  async function updateSummaryDetail() {
    if (!summaryDetailFilters) return;
    const data = await request(`/api/transactions?paged=true&limit=100&${new URLSearchParams(summaryDetailFilters)}`, { csrf });
    summaryDetail = data.rows;
  }

  async function sendChat() {
    const text = chatText.trim(); if (!text) return;
    messages = [...messages, { user: true, text }]; chatText = '';
    try { const data = await request('/api/assistant/message', { csrf, method: 'POST', body: { text } }); messages = [...messages, { text: data.text }]; } catch (error) { messages = [...messages, { text: error.message }]; }
  }
</script>

{#if !signedIn}
  <main class="login-shell">
    <section class="card login"><h1>Borton</h1><form on:submit|preventDefault={signIn}><input bind:value={loginPassword} type="password" placeholder="Password" required><button>Sign in</button>{#if loginError}<output class="error">{loginError}</output>{/if}</form></section>
  </main>
{:else}
  <main class="shell">
    <aside><h1>Borton</h1><small>Synced {new Date(boot.syncedAt).toLocaleTimeString()}</small><nav><span class="nav-heading">View</span><button class:active={view === 'home'} on:click={() => show('home')}>Home</button><button class:active={view === 'summary'} on:click={() => show('summary')}>Summary</button><span class="nav-heading">Actions</span><button class="nav-action" class:active={view === 'add'} on:click={() => show('add')}><b aria-hidden="true">＋</b><span>Add expense</span></button><button class="nav-action" class:active={view === 'check'} on:click={() => show('check')}><b aria-hidden="true">⌕</b><span>Check an expense</span></button></nav></aside>
    <section class="main"><header><div class="mobile-nav"><button on:click={() => show('home')}>Home</button><button on:click={() => show('summary')}>Summary</button></div><button class="chat-trigger" on:click={() => chatOpen = true} aria-label="Open chat" title="Chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.2-.6L4 20l1.5-4.1A7.2 7.2 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg></button></header>

      {#if view === 'home'}
        <section class="card"><div class="toolbar page-toolbar"><h2>Recent expenses</h2><div class="toolbar-actions"><button class="icon-button" class:pressed={hideAmounts} on:click={toggleAmounts} aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'} title={hideAmounts ? 'Show amounts' : 'Hide amounts'}>{@html hideAmounts ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.8 10.8 0 0 1 12 4c5.2 0 8.8 5.1 9.8 8-0.4 1.1-1.2 2.6-2.5 4M6.2 6.2C4.2 7.8 2.8 10.2 2.2 12c1 2.9 4.6 8 9.8 8 1.3 0 2.5-.3 3.6-.8"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12C3.2 9.1 6.8 4 12 4s8.8 5.1 9.8 8c-1 2.9-4.6 8-9.8 8S3.2 14.9 2.2 12Z"/><circle cx="12" cy="12" r="3"/></svg>' }</button><button class="icon-button" on:click={loadBoot} aria-label="Refresh recent expenses" title={`Updated ${new Date(boot.syncedAt).toLocaleString()}`}>↻</button>{#if recentUpdatedAt}<small class="updated">Updated {recentUpdatedAt.toLocaleString()}</small>{/if}</div></div>
          <section class="quick-add"><h3>Quick add</h3><form on:submit|preventDefault={addQuickExpense}><div class="quick-fields"><label>Merchant<input bind:value={quick.merchant} placeholder="Merchant" required></label><label>Amount<input bind:value={quick.amount} placeholder="Amount" inputmode="decimal" required></label><label>Date<input bind:value={quick.date} type="date" required></label><Picker label="Paid from" items={accounts} bind:value={quick.account} placeholder="Search accounts" required /><Picker label="Category" items={categories} bind:value={quick.category} placeholder="Search categories" required /></div><label class="quick-note">Notes<textarea bind:value={quick.note} rows="3" placeholder="What was this for?"></textarea><DictationButton bind:value={quick.note} {csrf} /></label><div class="quick-actions"><button>Add expense</button>{#if quickError}<output class="error">{quickError}</output>{/if}</div></form></section>
          <div class="toolbar search-bar"><input bind:value={search} placeholder="Search merchant or notes"><button on:click={searchTransactions}>Search</button></div>
          <table class="transactions"><thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th>Category</th><th>Notes</th><th class="amount">Amount</th></tr></thead><tbody>{#each transactions as row}<tr><td>{row.date}</td><td>{row.merchant}</td><td>{row.account}</td><td>{row.category}</td><td>{row.note || '—'}</td><td class="amount">{money(row.amountCents)}</td></tr>{:else}<tr><td colspan="6" class="muted">No transactions found.</td></tr>{/each}</tbody></table>
        </section>
      {:else if view === 'summary'}
        <section class="card"><div class="toolbar page-toolbar">{#if summaryDetail}<button class="back-title" on:click={() => { summaryDetail = null; summaryDetailFilters = null; }} aria-label="Back to summary">← <span>Summary</span></button>{:else}<h2>Summary</h2>{/if}<div class="toolbar-actions"><button class="icon-button" class:pressed={hideAmounts} on:click={toggleAmounts} aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'} title={hideAmounts ? 'Show amounts' : 'Hide amounts'}>{@html hideAmounts ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.8 10.8 0 0 1 12 4c5.2 0 8.8 5.1 9.8 8-0.4 1.1-1.2 2.6-2.5 4M6.2 6.2C4.2 7.8 2.8 10.2 2.2 12c1 2.9 4.6 8 9.8 8 1.3 0 2.5-.3 3.6-.8"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12C3.2 9.1 6.8 4 12 4s8.8 5.1 9.8 8c-1 2.9-4.6 8-9.8 8S3.2 14.9 2.2 12Z"/><circle cx="12" cy="12" r="3"/></svg>' }</button><button class="icon-button" on:click={() => loadSummary(true)} aria-label="Refresh summary" title={summaryUpdatedAt ? `Updated ${summaryUpdatedAt.toLocaleString()}` : 'Refresh summary'}>↻</button>{#if summaryUpdatedAt}<small class="updated">Updated {summaryUpdatedAt.toLocaleString()}</small>{/if}</div></div>
          {#if summaryDetail}<div class="summary-detail-heading"><label>From<input bind:value={summaryDetailFilters.start} type="date" on:change={updateSummaryDetail}></label><label>To<input bind:value={summaryDetailFilters.end} type="date" on:change={updateSummaryDetail}></label><Picker label="Account" items={accounts} bind:value={detailAccount} placeholder="All accounts" on:change={() => { summaryDetailFilters.accountId = matchItem(accounts, detailAccount)?.id || ''; updateSummaryDetail(); }} /><Picker label="Category" items={categories} bind:value={detailCategory} placeholder="All categories" on:change={() => { summaryDetailFilters.categoryId = matchItem(categories, detailCategory)?.id || ''; updateSummaryDetail(); }} /><button class="secondary" on:click={updateSummaryDetail}>Apply</button></div><table class="transactions"><tbody>{#each summaryDetail as row}<tr><td>{row.date}</td><td>{row.merchant}</td><td>{row.note}</td><td class="amount">{money(row.amountCents)}</td></tr>{/each}</tbody></table>{:else if summaryData}<div class="summary-period"><label>Period<select bind:value={summaryPeriod} on:change={() => loadSummary()}><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option><option value="all">All time</option></select></label></div><div class="summary-total"><span>{periodLabel(summaryData.period)} · {summaryData.start} to {summaryData.end}</span><strong>{money(summaryData.totalCents)}</strong><small>{summaryData.count} expenses</small></div><section class="summary-visuals"><article class="chart-card"><div><h3>Spending by category</h3><p class="muted">Tap a category to view its expenses.</p></div><div class="donut-wrap"><div class="donut" style={`background:${categoryGradient(categoryChart)}`}><strong>{money(summaryData.totalCents)}</strong><small>Total</small></div><ol class="chart-legend">{#each categoryChart as row, index}<li><button disabled={!row.filters} on:click={() => row.filters && openDetail(row.filters)}><i style={`background:${chartColors[index % chartColors.length]}`}></i><span>{row.name}</span><strong>{money(row.amountCents)}</strong></button></li>{/each}</ol></div></article><article class="chart-card month-chart"><div><h3>Monthly spending</h3><p class="muted">Hover a bar to see its categories, or tap it to view the month.</p></div><div class="bars">{#each monthChart as row}<button aria-label={`${monthLongLabel(row.name)}: ${money(row.amountCents)}`} on:mouseenter={() => hoveredMonth = row} on:focus={() => hoveredMonth = row} on:click={() => openDetail(row.filters)}><span class="bar stack" style={`height:${monthHeight(row.amountCents)}%`}>{#each row.categories as category}<i aria-label={`${category.name}: ${money(category.amountCents)}`} style={`background:${categoryColor(category)};flex:${category.amountCents}`}></i>{/each}</span><small>{monthLabel(row.name)}</small></button>{/each}</div>{#if hoveredMonth}<section class="month-breakdown"><div><strong>{monthLongLabel(hoveredMonth.name)}</strong><span>{money(hoveredMonth.amountCents)}</span></div><ol>{#each hoveredMonth.categories as category}<li><i style={`background:${categoryColor(category)}`}></i><span>{category.name}</span><strong>{money(category.amountCents)}</strong></li>{/each}</ol></section>{/if}</article></section><div class="breakdown-grid">{#each [['Category', summaryData.byCategory], ['Account', summaryData.byAccount], ['Month', summaryData.byMonth]] as [title, rows]}<article><h3>{title}</h3><ol>{#each rows as row}<li><button on:click={() => openDetail(row.filters)}><span>{row.name} <small>({row.count})</small></span><strong>{money(row.amountCents)}</strong></button></li>{/each}</ol></article>{/each}</div>{:else}<p class="muted">Loading…</p>{/if}
        </section>
      {:else if view === 'add'}
        <section class="card"><h2>Review expenses</h2>{#if batch.length}<section class="batch">{#each batch as row, index (row.clientId)}<article class="receipt"><label>Merchant<input bind:value={row.merchant}></label><label>Amount<input bind:value={row.amount} inputmode="decimal"></label><label>Date<input bind:value={row.date} type="date"></label><Picker label="Paid from" items={accounts} bind:value={row.account} placeholder="Search accounts" /><Picker label="Category" items={categories} bind:value={row.category} placeholder="Search categories" /><label class="receipt-note">Notes<textarea bind:value={row.note} rows="2"></textarea><DictationButton bind:value={row.note} {csrf} /></label>{#if row.duplicates?.length}<label class="duplicate-choice">Likely duplicate <input bind:checked={row.duplicateAcknowledged} type="checkbox"> intentionally new</label>{/if}</article>{/each}</section><button on:click={saveBatch}>Save expenses</button>{#if quickError}<output class="error">{quickError}</output>{/if}{:else}<p class="muted">Use Check an expense to upload a receipt, or add one from Home.</p>{/if}</section>
      {:else if view === 'check'}
        <section class="card"><h2>Check an expense</h2><p>Upload a receipt or ask Chat when you only remember part of it.</p><form on:submit|preventDefault={extractReceipt}><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" required><button>Read receipt</button>{#if quickError}<output class="error">{quickError}</output>{/if}</form><details><summary>Enter known details</summary><button on:click={() => chatOpen = true}>Ask in Chat</button></details></section>
      {/if}
    </section>
    {#if chatOpen}<section class="card chat"><button on:click={() => chatOpen = false}>Close</button><div class="messages">{#each messages as message}<div class:user={message.user} class="message">{message.text}</div>{:else}<p class="muted">Ask about an expense, a duplicate, or a bulk change.</p>{/each}</div><form on:submit|preventDefault={sendChat}><textarea bind:value={chatText} rows="3"></textarea><button>Send</button></form></section>{/if}
  </main>
{/if}
