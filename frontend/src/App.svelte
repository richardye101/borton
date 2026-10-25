<script>
  import { onMount } from 'svelte';
  import { request } from './lib/api.js';
  import { createSummaryCache } from './lib/client-state.js';
  import { itemName, matchItem } from './lib/expense-form.js';
  import Picker from './lib/Picker.svelte';
  import DictationButton from './lib/DictationButton.svelte';

  let csrf = '';
  let boot = null;
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
  const summaryCache = createSummaryCache();

  onMount(async () => {
    hideAmounts = localStorage.getItem('borton-hide-amounts') === '1';
    try {
      const session = await fetch('/api/session');
      if (session.ok) { csrf = (await session.json()).csrf; await loadBoot(); }
    } catch {}
  });

  $: signedIn = !!boot;
  $: accounts = boot?.accounts || [];
  $: categories = boot?.categories || [];
  $: money = (cents) => hideAmounts ? '••••' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: boot?.currency || 'CAD' }).format((cents || 0) / 100);

  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${date.year}-${date.month}-${date.day}`;
  }

  async function loadBoot() {
    boot = await request('/api/bootstrap', { csrf });
    transactions = boot.transactions;
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
    let data = summaryCache.get(summaryPeriod);
    if (!data || force) { data = await request(`/api/summary?period=${summaryPeriod}${force ? '&force=true' : ''}`, { csrf }); summaryCache.set(summaryPeriod, data); }
    summaryData = data;
  }

  async function openDetail(filters) {
    const data = await request(`/api/transactions?paged=true&limit=100&${new URLSearchParams(filters)}`, { csrf });
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
    <aside><h1>Borton</h1><small>Synced {new Date(boot.syncedAt).toLocaleTimeString()}</small><nav><span>View</span><button class:active={view === 'home'} on:click={() => show('home')}>Home</button><button class:active={view === 'summary'} on:click={() => show('summary')}>Summary</button><span>Actions</span><button class:active={view === 'add'} on:click={() => show('add')}>＋ Add expense</button><button class:active={view === 'check'} on:click={() => show('check')}>Check an expense</button></nav></aside>
    <section class="main"><header><div class="mobile-nav"><button on:click={() => show('home')}>Home</button><button on:click={() => show('summary')}>Summary</button></div><button on:click={() => chatOpen = true}>◌ Chat</button></header>

      {#if view === 'home'}
        <section class="card"><div class="toolbar page-toolbar"><h2>Recent expenses</h2><div class="toolbar-actions"><button class="secondary" class:pressed={hideAmounts} on:click={toggleAmounts}>{hideAmounts ? 'Show amounts' : 'Hide amounts'}</button><button class="secondary" on:click={loadBoot}>Refresh</button></div></div>
          <section class="quick-add"><h3>Quick add</h3><form on:submit|preventDefault={addQuickExpense}><div class="quick-fields"><label>Merchant<input bind:value={quick.merchant} placeholder="Merchant" required></label><label>Amount<input bind:value={quick.amount} placeholder="Amount" inputmode="decimal" required></label><label>Date<input bind:value={quick.date} type="date" required></label><Picker label="Paid from" items={accounts} bind:value={quick.account} placeholder="Search accounts" required /><Picker label="Category" items={categories} bind:value={quick.category} placeholder="Search categories" required /></div><label class="quick-note">Notes<textarea bind:value={quick.note} rows="3" placeholder="What was this for?"></textarea><DictationButton bind:value={quick.note} /></label><div class="quick-actions"><button>Add expense</button>{#if quickError}<output class="error">{quickError}</output>{/if}</div></form></section>
          <div class="toolbar search-bar"><input bind:value={search} placeholder="Search merchant or notes"><button on:click={searchTransactions}>Search</button></div>
          <table class="transactions"><thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th>Category</th><th>Notes</th><th class="amount">Amount</th></tr></thead><tbody>{#each transactions as row}<tr><td>{row.date}</td><td>{row.merchant}</td><td>{row.account}</td><td>{row.category}</td><td>{row.note || '—'}</td><td class="amount">{money(row.amountCents)}</td></tr>{:else}<tr><td colspan="6" class="muted">No transactions found.</td></tr>{/each}</tbody></table>
        </section>
      {:else if view === 'summary'}
        <section class="card"><div class="toolbar page-toolbar"><h2>Summary</h2><div class="toolbar-actions"><select bind:value={summaryPeriod} on:change={() => loadSummary()}><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option><option value="all">All time</option></select><button class="secondary" class:pressed={hideAmounts} on:click={toggleAmounts}>{hideAmounts ? 'Show amounts' : 'Hide amounts'}</button><button class="secondary" on:click={() => loadSummary(true)}>Refresh</button></div></div>
          {#if summaryDetail}<button class="secondary" on:click={() => summaryDetail = null}>← Summary</button><table class="transactions"><tbody>{#each summaryDetail as row}<tr><td>{row.date}</td><td>{row.merchant}</td><td>{row.note}</td><td class="amount">{money(row.amountCents)}</td></tr>{/each}</tbody></table>{:else if summaryData}<div class="summary-total"><span>{summaryData.start} to {summaryData.end}</span><strong>{money(summaryData.totalCents)}</strong><small>{summaryData.count} expenses</small></div><div class="breakdown-grid">{#each [['Category', summaryData.byCategory], ['Account', summaryData.byAccount], ['Month', summaryData.byMonth]] as [title, rows]}<article><h3>{title}</h3><ol>{#each rows as row}<li><button on:click={() => openDetail(row.filters)}><span>{row.name} <small>({row.count})</small></span><strong>{money(row.amountCents)}</strong></button></li>{/each}</ol></article>{/each}</div>{:else}<p class="muted">Loading…</p>{/if}
        </section>
      {:else if view === 'add'}
        <section class="card"><h2>Review expenses</h2>{#if batch.length}<section class="batch">{#each batch as row, index (row.clientId)}<article class="receipt"><label>Merchant<input bind:value={row.merchant}></label><label>Amount<input bind:value={row.amount} inputmode="decimal"></label><label>Date<input bind:value={row.date} type="date"></label><Picker label="Paid from" items={accounts} bind:value={row.account} placeholder="Search accounts" /><Picker label="Category" items={categories} bind:value={row.category} placeholder="Search categories" /><label class="receipt-note">Notes<textarea bind:value={row.note} rows="2"></textarea><DictationButton bind:value={row.note} /></label>{#if row.duplicates?.length}<label class="duplicate-choice">Likely duplicate <input bind:checked={row.duplicateAcknowledged} type="checkbox"> intentionally new</label>{/if}</article>{/each}</section><button on:click={saveBatch}>Save expenses</button>{#if quickError}<output class="error">{quickError}</output>{/if}{:else}<p class="muted">Use Check an expense to upload a receipt, or add one from Home.</p>{/if}</section>
      {:else if view === 'check'}
        <section class="card"><h2>Check an expense</h2><p>Upload a receipt or ask Chat when you only remember part of it.</p><form on:submit|preventDefault={extractReceipt}><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" required><button>Read receipt</button>{#if quickError}<output class="error">{quickError}</output>{/if}</form><details><summary>Enter known details</summary><button on:click={() => chatOpen = true}>Ask in Chat</button></details></section>
      {/if}
    </section>
    {#if chatOpen}<section class="card chat"><button on:click={() => chatOpen = false}>Close</button><div class="messages">{#each messages as message}<div class:user={message.user} class="message">{message.text}</div>{:else}<p class="muted">Ask about an expense, a duplicate, or a bulk change.</p>{/each}</div><form on:submit|preventDefault={sendChat}><textarea bind:value={chatText} rows="3"></textarea><button>Send</button></form></section>{/if}
  </main>
{/if}
