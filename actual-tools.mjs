import { createHash } from 'node:crypto';

// The same declarations describe the model tools and validate every call locally.
const str = (description = '') => ({ type: 'string', description, maxLength: 4000 });
const id = str('Exact Actual ID from a read tool, or $ref from an earlier staged create.');
const num = { type: 'integer', description: 'Signed integer cents, never dollars.' };
const bool = { type: 'boolean' };
const en = (...values) => ({ type: 'string', enum: values });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const arr = (items, maxItems = 50) => ({ type: 'array', items, maxItems });
const nullable = s => ({ anyOf: [s, { type: 'null' }] });
const date = { ...str('YYYY-MM-DD'), pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const month = { ...str('YYYY-MM'), pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
const range = obj({ num1: num, num2: num }, ['num1', 'num2']);
const recurrence = obj({ frequency: en('daily', 'weekly', 'monthly', 'yearly'), start: date,
  interval: { type: 'integer', minimum: 1, maximum: 365 }, patterns: arr(obj({ value: num, type: en('SU','MO','TU','WE','TH','FR','SA','day') }, ['value','type'])),
  skipWeekend: bool, endMode: en('never','after_n_occurrences','on_date'), endOccurrences: { type: 'integer', minimum: 1 }, endDate: date, weekendSolveMode: en('before','after') }, ['frequency','start']);
const ruleValue = { anyOf: [str(), num, bool, arr(str()), range, recurrence, { type: 'null' }] };
const condition = obj({ field: en('account','amount','category','category_group','date','notes','payee','payee_name','imported_payee','saved','transfer','cleared','reconciled'),
  op: en('is','isNot','oneOf','notOneOf','contains','doesNotContain','matches','onBudget','offBudget','isapprox','isbetween','gt','gte','lt','lte','hasTags'), value: ruleValue,
  options: obj({ inflow: bool, outflow: bool, month: bool, year: bool }) }, ['field','op','value']);
const action = obj({ op: en('set','prepend-notes','append-notes','delete-transaction','set-split-amount'),
  field: en('account','category','payee','notes','amount','date','cleared','reconciled'), value: ruleValue,
  options: obj({ splitIndex: { type: 'integer', minimum: 1 }, method: en('fixed-amount','fixed-percent','remainder') }) }, ['op','value']);
const txnFields = obj({ account: id, date, amount: num, payee: nullable(id), category: nullable(id),
  notes: str(), cleared: bool, reconciled: bool });
const fields = {
  account: obj({ name: str(), offbudget: bool }),
  category: obj({ name: str(), group_id: id, is_income: bool, hidden: bool }),
  group: obj({ name: str(), is_income: bool, hidden: bool }),
  payee: obj({ name: str() }),
  tag: obj({ tag: str(), color: nullable(str()), description: nullable(str()) }),
  schedule: obj({ name: str(), posts_transaction: bool, payee: nullable(id), account: nullable(id), amount: { anyOf: [num, range] },
    amountOp: en('is','isapprox','isbetween'), date: { anyOf: [date, recurrence] } }),
  rule: obj({ stage: nullable(en('pre','post')), conditionsOp: en('and','or'), conditions: arr(condition), actions: arr(action) }),
  transaction: txnFields,
};
const filters = { query: str('Case-insensitive literal match, not a regular expression.'), ids: arr(id), limit: { type: 'integer', minimum: 1, maximum: 50 } };
const txnFilters = { ...filters, start: date, end: date, account: id, payee: id, category: id, amount: num, cleared: bool,
  includeNotes: bool, includeOffbudget: bool };
const definitions = [];
const declare = (name, description, parameters) => definitions.push({ name, description, parameters });
declare('list_accounts', 'Find accounts and stable IDs. Include balances only when needed.', obj({ ...filters, closed: bool, offbudget: bool, balances: bool }));
declare('list_categories', 'Find categories or category groups and their IDs, including hidden ones.', obj({ ...filters, groups: bool }));
for (const domain of ['payees','schedules','rules','tags']) declare('list_' + domain, 'Find ' + domain + ' and stable IDs. Results are capped at 50.', obj(filters));
declare('find_transactions', 'Find transactions in an explicit date range. Include notes only if relevant. Use run_report for totals, not capped rows.', obj(txnFilters, ['start','end']));
declare('get_budget', 'Read one budget month, optionally scoped to category IDs. Money is integer cents.', obj({ month, categories: arr(id) }, ['month']));
declare('get_note', 'Read an explicitly requested Actual note.', obj({ id }, ['id']));
declare('run_report', 'Compute accurate local totals, excluding transfers and split parents for spending/income. Balances/networth include all account entries. Money is cents.', obj({ ...txnFilters, metric: en('spending','income','cashflow','categories','balances','networth') }, ['metric','start','end']));
declare('propose_transaction_changes', 'Stage creates, edits, deletions or transfers. No writes until confirmation. Supply exact fields; transfer amount is positive cents leaving account. Use existing payee IDs or stage a payee create first.', obj({ changes: arr(obj({ action: en('create','update','delete','transfer'), id, fields: txnFields, destination: id, ref: str('Unique name for this created record, referenced later as $name.') }, ['action'])) }, ['changes']));
for (const domain of ['account','category','payee','schedule','rule','tag']) {
  const actions = ['create','update','delete', ...(domain === 'account' ? ['close','reopen'] : []), ...(domain === 'payee' ? ['merge'] : [])];
  declare('propose_' + domain + '_change', 'Stage a ' + domain + ' change. Deletion may affect dependent records; the preview includes affected-record counts. All changes require confirmation.', obj({
    action: en(...actions), id, fields: domain === 'category' ? obj({ ...fields.category.properties }) : fields[domain],
    ...(domain === 'category' ? { group: bool } : {}),
    ...(domain === 'account' ? { initialBalance: num, transferAccount: id, transferCategory: id } : {}),
    ...(domain === 'category' ? { transferCategory: id } : {}),
    ...(domain === 'payee' ? { mergeIds: arr(id) } : {}), ref: str('Unique name for a create; later arguments may reference $name.'),
  }, ['action']));
}
declare('propose_budget_change', 'Stage an absolute category budget amount/carryover, or hold/reset funds for next month. To increase, read current amount and compute new absolute amount.', obj({ month, category: id, amount: num, carryover: bool, hold: bool, resetHold: bool }, ['month']));
declare('propose_note_change', 'Stage replacement of an Actual note.', obj({ id, note: str() }, ['id','note']));
declare('propose_bank_sync', 'Stage bank import/sync; may add or change transactions. Omit account for all eligible accounts.', obj({ account: id }));
declare('propose_sync', 'Stage retry of cloud synchronization after an earlier sync failure.', obj({}));

export class ToolError extends Error {}
const fail = message => { throw new ToolError(message); };
export function validateSchema(schema, value, at = 'arguments') {
  if (schema.anyOf) {
    if (!schema.anyOf.some(s => { try { validateSchema(s, value, at); return true; } catch { return false; } })) fail(`${at}: invalid value type`);
    return;
  }
  if (schema.type === 'null') { if (value !== null) fail(`${at}: expected null`); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${at}: expected object`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail(`${at}: unknown field ${key}`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`${at}: missing ${key}`);
    for (const [key, val] of Object.entries(value)) validateSchema(schema.properties[key], val, `${at}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 50)) fail(`${at}: expected at most ${schema.maxItems ?? 50} items`);
    value.forEach((v, i) => validateSchema(schema.items, v, `${at}[${i}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) fail(`${at}: invalid integer`);
  } else if (typeof value !== schema.type) fail(`${at}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${at}: unsupported value`);
  if (typeof value === 'string') {
    if (value.length > (schema.maxLength ?? 4000) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(`${at}: invalid text/date`);
    if (schema === date || schema.pattern === date.pattern) {
      const d = new Date(value + 'T12:00:00Z');
      if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== value) fail(`${at}: invalid calendar date`);
    }
  }
}
const clone = o => structuredClone(o);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const stable = o => JSON.stringify(o, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = o => createHash('sha256').update(stable(o)).digest('hex');
const getters = { account:'getAccounts', category:'getCategories', group:'getCategoryGroups', payee:'getPayees', schedule:'getSchedules', rule:'getRules', tag:'getTags' };
const columns = {
  account:['id','name','offbudget','closed'], category:['id','name','group_id','is_income','hidden'], group:['id','name','is_income','hidden'],
  payee:['id','name','transfer_acct'], schedule:['id','name','rule','next_date','completed',...Object.keys(fields.schedule.properties)],
  rule:['id',...Object.keys(fields.rule.properties)], tag:['id','tag','color','description'],
  transaction:['id','account','date','amount','payee','category','notes','cleared','reconciled','is_parent','is_child','parent_id','transfer_id'],
};
const refsIn = o => typeof o === 'string' && /^\$[\w-]+$/.test(o) ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(refsIn) : [];
const resolveRefs = (o, refs) => typeof o === 'string' && /^\$[\w-]+$/.test(o) ? (refs[o.slice(1)] || fail(`Unresolved reference ${o}`))
  : Array.isArray(o) ? o.map(v => resolveRefs(v, refs)) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k,v]) => [k,resolveRefs(v,refs)])) : o;

export function createActualTools(api, { currency = 'CAD' } = {}) {
  const rawApi=api;let pendingWrite=false;
  // Actual's API has no cancellation signal. A timed-out write stays gated until it settles.
  api=new Proxy(rawApi,{get(target,key){const value=target[key];if(typeof value!=='function'||key==='q')return value;
    return (...args)=>new Promise((resolve,reject)=>{
      const isWrite=!/^(get|aqlQuery)/.test(String(key));let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;if(isWrite)pendingWrite=true;reject(new Error('Actual API timed out'));},isWrite?45_000:15_000);
      Promise.resolve().then(()=>value(...args)).then(resolve,reject).finally(()=>{clearTimeout(timer);if(timedOut&&isWrite)pendingWrite=false;});
    });}});
  const list = async kind => (await api[getters[kind]](...(['category','group'].includes(kind) ? [{ hidden:true }] : []))).map(r => pick(r, columns[kind]));
  const rowsFor = async args => {
    if (args.start > args.end) fail('start must precede end');
    const accounts = await list('account');
    const selected = args.account ? accounts.filter(a => a.id === args.account) : accounts;
    if (args.account && !selected.length) fail('Unknown account ID; use list_accounts');
    const rows = [];
    for (const account of selected) {
      const ts = await api.getTransactions(account.id, args.start, args.end);
      const flat = ts.flatMap(t => [t, ...(t.subtransactions || []).map(c => ({...c,account:account.id,date:c.date||t.date,is_child:true,parent_id:t.id}))]);
      const unique = [...new Map(flat.map(t => [t.id,t])).values()];
      rows.push(...unique.map(t => ({...pick(t,columns.transaction),account:account.id,_offbudget:!!account.offbudget})));
    }
    const payees = await list('payee'); const categories = await list('category');
    const pmap = Object.fromEntries(payees.map(p => [p.id,p])); const cmap = Object.fromEntries(categories.map(c => [c.id,c]));
    const amap = Object.fromEntries(accounts.map(a => [a.id,a]));
    return rows.map(t => ({ ...t, payeeName:pmap[t.payee]?.name || '', accountName:amap[t.account]?.name || '', categoryName:cmap[t.category]?.name || '', _transfer:!!(t.transfer_id || pmap[t.payee]?.transfer_acct) }))
      .filter(t => (!args.ids || args.ids.includes(t.id)) && (!args.category || t.category === args.category) && (!args.payee || t.payee === args.payee)
        && (args.amount === undefined || t.amount === args.amount) && (args.cleared === undefined || !!t.cleared === args.cleared)
        && (!args.query || `${t.payeeName} ${t.notes||''}`.toLowerCase().includes(args.query.toLowerCase())));
  };
  const record = async (kind, key) => {
    if (kind === 'transaction') {
      const { data } = await api.aqlQuery(api.q('transactions').filter({ id:key }).select('*'));
      const r = data[0]; return r ? pick({...r, date:String(r.date)}, columns.transaction) : null;
    }
    if (kind === 'note') return { id:key, note:(await api.getNote(key))?.note ?? null };
    if (kind === 'budget') {
      const [m,c] = key.split('/'); const b = await api.getBudgetMonth(m);
      if (!c) return pick(b,['month','toBudget','forNextMonth','totalBudgeted','totalBalance']);
      const category = (b.categoryGroups||[]).flatMap(g => g.categories||[]).find(x => x.id === c);
      return category ? pick(category,['id','name','budgeted','spent','balance','carryover']) : null;
    }
    return (await list(kind)).find(r => r.id === key) || null;
  };
  const windowed = (rows, args) => {
    const matching = rows.filter(r => (!args.ids || args.ids.includes(r.id)) && (!args.query || stable(r).toLowerCase().includes(args.query.toLowerCase())));
    const n=args.limit||50;
    return { rows: matching.slice(0,n), count: matching.length, truncated: matching.length>n };
  };
  const read = async (name, args) => {
    const def = definitions.find(d => d.name === name && !name.startsWith('propose_'));
    if (!def) fail('Unknown read tool'); validateSchema(def.parameters,args);
    if (name === 'find_transactions' || name === 'run_report') {
      const rows = await rowsFor(args);
      if (name === 'find_transactions') return { ...windowed(rows.map(t => pick(t,[...columns.transaction.filter(k => k!=='notes'), 'accountName','payeeName','categoryName',...(args.includeNotes?['notes']:[])])), { limit:args.limit }), unit:'cents' };
      if (args.metric === 'balances' || args.metric === 'networth') {
        const accounts = (await list('account')).filter(a => !args.account || a.id === args.account);
        const balances=[];
        for(const a of accounts) balances.push({id:a.id,name:a.name,amount:await api.getAccountBalance(a.id,new Date(args.end+'T23:59:59Z'))});
        return {metric:args.metric,asOf:args.end,unit:'cents',total:balances.reduce((n,a)=>n+a.amount,0),...(args.metric==='balances'?windowed(balances,args):{})};
      }
      const kept=rows.filter(t=>!t.is_parent&&!t._transfer&&(args.includeOffbudget||!t._offbudget));
      const income=kept.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0);
      const outflow=kept.filter(t=>t.amount<0).reduce((s,t)=>s-t.amount,0);
      const out={metric:args.metric,start:args.start,end:args.end,unit:'cents',count:kept.length,total:args.metric==='income'?income:args.metric==='cashflow'?income-outflow:outflow};
      if(args.metric==='categories') { const totals=new Map(); for(const t of kept.filter(t=>t.amount<0)) { const key=t.category||'uncategorized'; const r=totals.get(key)||{id:key,name:t.categoryName||'Uncategorized',amount:0};r.amount-=t.amount;totals.set(key,r); } Object.assign(out,windowed([...totals.values()].sort((a,b)=>b.amount-a.amount),{})); }
      return out;
    }
    if(name==='get_note') return record('note',args.id);
    if(name==='get_budget') {
      const b=await api.getBudgetMonth(args.month); const cats=(b.categoryGroups||[]).flatMap(g=>(g.categories||[]).map(c=>({...pick(c,['id','name','budgeted','spent','balance','carryover']),group:g.name})));
      return {...pick(b,['month','toBudget','forNextMonth','totalBudgeted','totalIncome','totalSpent','totalBalance']),...windowed(cats,{ids:args.categories}),unit:'cents'};
    }
    const kind=name==='list_categories'?(args.groups?'group':'category'):({list_accounts:'account',list_payees:'payee',list_schedules:'schedule',list_rules:'rule',list_tags:'tag'})[name];
    let rows=await list(kind);
    if(kind==='account') rows=rows.filter(r=>(args.closed===undefined||!!r.closed===args.closed)&&(args.offbudget===undefined||!!r.offbudget===args.offbudget));
    const out=windowed(rows,args);
    if(kind==='account'&&args.balances) for(const r of out.rows) r.balance=await api.getAccountBalance(r.id);
    return out;
  };
  async function prepare(name,args,previous=[]) {
    const def=definitions.find(d=>d.name===name&&name.startsWith('propose_'));
    if(!def) fail('Unknown proposal tool'); validateSchema(def.parameters,args);
    if(name==='propose_transaction_changes') {
      if(!args.changes.length) fail('No transaction changes supplied');
      const result=[];
      for(const change of args.changes) result.push(await stage({domain:'transaction',...change}, [...previous,...result]));
      return result;
    }
    const domain=name.slice('propose_'.length).replace(/_change$/,'');
    return [await stage({ domain:domain==='category'&&args.group?'group':domain, ...args },previous)];
  }
  async function stage(input,previous) {
    const op=clone(input); const {domain,action}=op; const f=op.fields||{}; op.snapshots=[];op.labels={};
    if(previous.length>=50) fail('At most 50 operations per plan; narrow the request');
    if(op.ref&&(!/^[A-Za-z][\w-]{0,39}$/.test(op.ref)||previous.some(p=>p.ref===op.ref))) fail('Create reference must be unique');
    if(op.ref&&action!=='create') fail('Only create operations have references');
    const watch=async(kind,key)=>{
      if(!key) return null;
      if(key.startsWith('$')) {
        const p=previous.find(p=>p.ref===key.slice(1));
        if(!p||p.domain!==kind||p.action!=='create') fail(`Invalid ${kind} reference ${key}`);
        op.labels[key]=p.fields?.name||p.fields?.tag||key;
        return {id:key,...p.fields};
      }
      const r=await record(kind,key); if(!r) fail(`Unknown ${kind} ID; use the read tools to find it`);
      op.labels[key]=r.name||r.tag||r.date||key;
      op.snapshots.push({kind,key,hash:digest(r)}); return r;
    };
    const target=op.id?await watch(domain,op.id):null;
    if(target&&domain==='transaction') for(const [key,kind] of Object.entries({account:'account',payee:'payee',category:'category'})) if(target[key]) await watch(kind,target[key]);
    if(fields[domain]) {
      validateSchema(fields[domain],f,'fields');
      if(!action) fail('Action required');
      if(action==='create') {
        if(op.id) fail('A create cannot supply an existing ID');
        const required=({account:['name'],category:['name','group_id'],group:['name'],payee:['name'],tag:['tag'],schedule:['date','amountOp','posts_transaction'],rule:['stage','conditionsOp','conditions','actions'],transaction:['account','date','amount']})[domain];
        for(const key of required) if(f[key]===undefined||f[key]==='') fail(`Create ${domain} requires ${key}`);
      } else if(action!=='transfer'&&!target) fail('Existing target ID required');
      if(action==='update'&&!Object.keys(f).length) fail('Update fields cannot be empty');
      if(['delete','close','reopen','merge'].includes(action)&&Object.keys(f).length) fail('This action does not accept fields');
      if((f.name!==undefined&&!f.name.trim())||(f.tag!==undefined&&!f.tag.trim())) fail('Name cannot be empty');
    }
    for(const [key,kind] of Object.entries({account:'account',payee:'payee',category:'category',group_id:'group'})) if(f[key]) await watch(kind,f[key]);
    if(domain==='transaction') {
      if(action==='transfer') {
        if(!f.account||!f.date||!(f.amount>0)||!op.destination) fail('Transfer needs source account, destination, date and positive cents');
        if(f.account===op.destination) fail('Transfer accounts must differ');
        if(f.payee||f.category) fail('Transfer payee is derived from destination; omit payee/category');
        await watch('account',op.destination);
      }
      if(target?.is_parent&&['category','amount','payee'].some(k=>k in f)) fail('This is a split parent. Select its child transactions for category/amount/payee edits.');
      if(target?.is_child&&('account' in f||'date' in f||action==='delete'||'amount' in f)) fail('Changing split structure through individual children is unsupported; use the receipt split flow.');
      if(target?.transfer_id&&('account' in f||'payee' in f)) fail('Changing a linked transfer account/payee requires a separate transfer plan');
      if(target?.transfer_id) await watch('transaction',target.transfer_id);
    }
    if(domain==='group'&&f.group_id) fail('Category groups cannot contain a group_id');
    if(op.initialBalance!==undefined&&action!=='create') fail('initialBalance only applies to new accounts');
    if(op.transferAccount) await watch('account',op.transferAccount);
    if(op.transferCategory) await watch('category',op.transferCategory);
    if(op.transferAccount===op.id&&op.transferAccount) fail('Cannot transfer to the account being closed');
    if(op.transferCategory===op.id&&op.transferCategory) fail('Cannot transfer to the category being deleted');
    if(domain==='payee'&&target?.transfer_acct) fail('Transfer payees are managed through their accounts');
    if(action==='merge') {
      if(!op.mergeIds?.length||op.mergeIds.includes(op.id)) fail('Merge needs distinct source payee IDs');
      for(const source of op.mergeIds) {const p=await watch('payee',source);if(p.transfer_acct) fail('Cannot merge transfer payees');}
    }
    if(domain==='budget') {
      const hold=op.hold||op.resetHold;
      if(hold&&(op.category||op.carryover!==undefined||op.hold&&op.resetHold)) fail('Hold/reset cannot be combined with category changes');
      if(op.resetHold&&op.amount!==undefined) fail('resetHold does not take amount');
      if(!hold&&!op.category) fail('Category ID required');
      if(!op.resetHold&&op.amount===undefined&&op.carryover===undefined) fail('Budget amount or carryover required');
      if(op.category) await watch('category',op.category);
      if(!op.category?.startsWith('$')) { const before=await record('budget',op.month+(op.category?'/'+op.category:''));if(!before) fail('Category missing from budget month'); op.snapshots.push({kind:'budget',key:op.month+(op.category?'/'+op.category:''),hash:digest(before)});op.before=before; }
    }
    if(domain==='schedule') {
      const combined={...target,...f};
      if(combined.amountOp==='isbetween'&&(typeof combined.amount!=='object'||combined.amount===null)) fail('isbetween requires amount {num1,num2}');
      if(combined.amountOp!=='isbetween'&&typeof combined.amount==='object') fail('Schedule amount must be integer cents');
      if(combined.posts_transaction&&(!combined.account||!combined.payee)) fail('Auto-post schedules need an account and payee');
    }
    if(domain==='rule') {
      const r={...target,...f}; if(!r.conditions?.length||!r.actions?.length) fail('Rules require at least one condition and action');
      for(const c of r.conditions) {
        if(c.op==='matches') {try{new RegExp(c.value);}catch{fail('Invalid rule regular expression');}}
        if(['account','category','category_group','payee'].includes(c.field)&&['is','isNot','oneOf','notOneOf'].includes(c.op)) for(const value of [c.value].flat()) await watch(c.field==='category_group'?'group':c.field,value);
      }
      for(const a of r.actions) {
        if(a.op==='set'&&!a.field) fail('Set rule action requires a field');
        if(a.op==='set'&&['account','category','payee'].includes(a.field)) await watch(a.field,a.value);
      }
    }
    if(domain==='bank_sync'&&op.account) await watch('account',op.account);
    op.before=op.before||target;
    if(action==='delete'||action==='merge'||domain==='account'&&action==='close') {
      // Snapshot dependent transactions so a changed destructive impact invalidates the preview.
      const related=await impact(domain,op.id,op.mergeIds);
      op.impact=related.counts;op.impactHash=related.hash;
    }
    const ruleRefs=domain==='rule'?[...(f.conditions||[]),...(f.actions||[])].filter(r=>['account','category','category_group','payee'].includes(r.field)).map(r=>r.value):[];
    op.depends=refsIn({id:op.id,fields:pick(f,['account','category','group_id','payee']),ruleRefs,category:op.category,destination:op.destination,transferAccount:op.transferAccount,transferCategory:op.transferCategory,mergeIds:op.mergeIds,account:op.account});
    op.preview=preview(op);
    return op;
  }
  async function impact(kind,key,mergeIds=[]) {
    const selected=[key,...mergeIds]; const all=await rowsFor({start:'1900-01-01',end:'9999-12-31'});
    const categories=kind==='group'?(await list('category')).filter(c=>c.group_id===key).map(c=>c.id):selected;
    const affected=all.filter(t=>kind==='account'?selected.includes(t.account):kind==='category'||kind==='group'?categories.includes(t.category):kind==='payee'?selected.includes(t.payee):false);
    const budgets=[];
    if(kind==='category'||kind==='group') for(const m of await api.getBudgetMonths()) {const b=await api.getBudgetMonth(m);budgets.push({month:m,categories:(b.categoryGroups||[]).flatMap(g=>g.categories||[]).filter(c=>categories.includes(c.id))});}
    const configs=(['account','category','group','payee'].includes(kind))?[...(await list('rule')),...(await list('schedule'))].filter(r=>selected.some(k=>stable(r).includes(k))):[];
    return {counts:{transactions:affected.length,budgetMonths:budgets.length,relatedRulesOrSchedules:configs.length},hash:digest({affected:affected.sort((a,b)=>a.id.localeCompare(b.id)),budgets,configs})};
  }
  function preview(op) {
    const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency}).format(n/100);
    const label=op.domain==='transaction'&&op.before?`${op.before.date} ${op.labels[op.before.payee]||''} (${money(op.before.amount)})`:op.before?.name||op.before?.tag||op.labels[op.id]||op.id||op.fields?.name||op.fields?.tag||op.ref||op.domain;
    const detail=op.domain==='budget'?pick(op,['month','category','amount','carryover','hold','resetHold']):op.domain==='note'?{note:op.note}:op.fields||pick(op,['account']);
    const extras=pick(op,['initialBalance','destination','transferAccount','transferCategory','mergeIds']);
    const human=(key,value)=>value===null?'none':typeof value==='boolean'?(value?'yes':'no'):typeof value==='number'&&['amount','initialBalance','budgeted','balance','spent'].includes(key)?money(value):typeof value==='string'?(op.labels[value]||value):JSON.stringify(value);
    const labels={group_id:'Group',offbudget:'Off budget',is_income:'Income',posts_transaction:'Automatically post',amountOp:'Amount matching',transferAccount:'Transfer balance to',transferCategory:'Reassign category to',initialBalance:'Starting balance',resetHold:'Reset funds held',carryover:'Carry over',ref:'Reference'};
    const changes=Object.entries({...detail,...extras}).map(([k,v])=>{
      const old=op.before?.[k==='amount'&&op.domain==='budget'?'budgeted':k];
      return `  ${labels[k]||k.charAt(0).toUpperCase()+k.slice(1)}: ${old!==undefined&&op.action!=='create'?human(k,old)+' → ':''}${human(k,v)}`;
    });
    const warning=op.action==='delete'||op.action==='merge'||op.action==='close'||op.domain==='bank_sync'?'⚠ ':'';
    const title=op.domain==='bank_sync'?'Import latest bank transactions':op.domain==='sync'?'Retry cloud synchronization':`${op.action||'Set'} ${op.domain}: ${label}`;
    return warning+title+'\n'+changes.join('\n')+(op.impact?`\n  Impact: ${op.impact.transactions} transactions, ${op.impact.budgetMonths} budget months, ${op.impact.relatedRulesOrSchedules} related rules/schedules.`:'');
  }
  async function validate(operations) {
    if(pendingWrite) fail('An earlier Actual write has not finished. Wait for it to settle before requesting a fresh plan.');
    const seen=new Set();const removed=new Set();
    for(const op of operations) {
      for(const ref of op.depends) if(!seen.has(ref.slice(1))) fail('A create must precede its dependent changes');
      if(op.ref) seen.add(op.ref);
      for(const s of op.snapshots) {if(removed.has(s.kind+':'+s.key)) fail('A plan uses a record after deleting it'); const current=await record(s.kind,s.key); if(!current||digest(current)!==s.hash) fail('Actual data changed since the preview. Ask me to refresh the plan.');}
      if(op.impactHash&&(await impact(op.domain,op.id,op.mergeIds)).hash!==op.impactHash) fail('The destructive impact changed. Refresh the plan.');
      if(op.action==='delete'||op.action==='merge'||op.action==='close') {
        const affected=op.action==='merge'?op.mergeIds:[op.id];
        for(const key of affected) removed.add(op.domain+':'+key);
        if(['account','category','group','payee'].includes(op.domain)&&operations.some(other=>other!==op&&other.domain!==op.domain)) fail('Run destructive object changes separately from changes to other object types.');
      }
    }
  }
  async function execute(original,refs={}) {
    // Resolve only identifiers, never free text that happens to contain "$".
    const op={...original,fields:clone(original.fields||{})};
    for(const k of ['id','category','destination','transferAccount','transferCategory','account']) if(op[k]?.startsWith('$')) op[k]=resolveRefs(op[k],refs);
    if(op.mergeIds) op.mergeIds=resolveRefs(op.mergeIds,refs);
    for(const k of ['account','category','group_id','payee']) if(op.fields[k]?.startsWith('$')) op.fields[k]=resolveRefs(op.fields[k],refs);
    if(op.domain==='rule') for(const r of [...(op.fields.conditions||[]),...(op.fields.actions||[])]) if(['account','category','category_group','payee'].includes(r.field)) r.value=resolveRefs(r.value,refs);
    const {domain,action,id}=op;const f=op.fields;let result;
    if(domain==='transaction') {
      if(action==='delete') result=await api.deleteTransaction(id);
      else if(action==='update') {
        result=await api.updateTransaction(id,f);
        if(Array.isArray(result)&&!result.length) throw new Error('Actual did not update the target transaction');
      }
      else {
        if(action==='transfer') {const p=(await list('payee')).find(p=>p.transfer_acct===op.destination);if(!p) fail('Destination has no transfer payee'); f.payee=p.id;f.amount=-f.amount;}
        const imported_id='agent-'+original.executionKey;
        await api.addTransactions(f.account,[{...f,imported_id}],{runTransfers:true,learnCategories:false});
        const created=(await api.getTransactions(f.account,f.date,f.date)).find(t=>t.imported_id===imported_id);
        if(!created) throw new Error('Write completed but created transaction could not be located');
        result=created.id;
      }
    } else if(domain==='budget') {
      if(op.resetHold) await api.resetBudgetHold(op.month);
      else if(op.hold) await api.holdBudgetForNextMonth(op.month,op.amount);
      else {if(op.amount!==undefined) await api.setBudgetAmount(op.month,op.category,op.amount);if(op.carryover!==undefined) await api.setBudgetCarryover(op.month,op.category,op.carryover);}
    } else if(domain==='note') await api.updateNote(id,op.note);
    else if(domain==='bank_sync') await api.runBankSync(op.account?{accountId:op.account}:undefined);
    else if(domain==='sync') await api.sync();
    else if(domain==='account'&&action==='close') await api.closeAccount(id,op.transferAccount,op.transferCategory);
    else if(domain==='account'&&action==='reopen') await api.reopenAccount(id);
    else if(domain==='payee'&&action==='merge') await api.mergePayees(id,op.mergeIds);
    else {
      const suffix=({account:'Account',category:'Category',group:'CategoryGroup',payee:'Payee',tag:'Tag',schedule:'Schedule',rule:'Rule'})[domain];
      const method=action+suffix;
      if(action==='create') result=await api[method](f,...(domain==='account'?[op.initialBalance||0]:[]));
      else if(action==='delete') result=await api[method](id,...(['category','group'].includes(domain)?[op.transferCategory]:[]));
      else if(domain==='rule') result=await api.updateRule({ ...pick(op.before,columns.rule),...f,id });
      else result=await api[method](id,f);
    }
    const createdId=typeof result==='string'?result:result?.id;
    if(op.ref) {if(!createdId) throw new Error('Create did not return its ID'); refs[op.ref]=createdId;}
    return {ok:true,...(createdId?{id:createdId}:{}),domain,action:action||'set'};
  }
  // Gemini's OpenAPI subset omits local-only bounds; validation still enforces them.
  const geminiSchema = s => s.anyOf ? { anyOf:s.anyOf.filter(x=>x.type!=='null').map(geminiSchema),...(s.anyOf.some(x=>x.type==='null')?{nullable:true}:{}) }
    : { type:s.type.toUpperCase(),...(s.description?{description:s.description}:{}),...(s.enum?{enum:s.enum}:{}),...(s.properties?{properties:Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,geminiSchema(v)])),...(s.required.length?{required:s.required}:{})}:{}),...(s.items?{items:geminiSchema(s.items)}:{}) };
  return {declarations:definitions.map(d=>({...d,parameters:geminiSchema(d.parameters)})),read,prepare,validate,execute,sync:()=>api.sync(),hasPendingWrite:()=>pendingWrite};
}
