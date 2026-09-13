// Exercise the real receipt bridge and writers without Telegram or a real budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createActualTools, ToolError } from '../actual-tools.mjs';
import { createAgent, createGeminiGenerate } from '../agent.mjs';

const source = fs.readFileSync(new URL('../bot.mjs',import.meta.url),'utf8');
function declaration(name) {
  const constant=source.match(new RegExp(`^const ${name} = .+;$`,'m'));
  if (constant) return constant[0];
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
function fixture() {
  let serial=0, failDelete=false;
  const accounts=[{id:'card',name:'Wealthsimple VIP',offbudget:false},{id:'tia-card',name:'Tia Mastercard',offbudget:true}];
  const categories=[{id:'home',name:'Home'},{id:'general',name:'General'}];
  const payees=accounts.map(a=>({id:'transfer-'+a.id,name:'Transfer: '+a.name,transfer_acct:a.id}));
  const rows=[],writes=[];
  const api={
    getAccounts:async()=>structuredClone(accounts), getCategories:async({hidden=false}={})=>hidden?[]:structuredClone(categories),
    getPayees:async()=>structuredClone(payees), sync:async()=>{},
    q:()=>({filter(v){this.where=v;return this;},select(){return this;}}),
    aqlQuery:async q=>({data:structuredClone(rows.filter(r=>r.id===q.where.id))}),
    getTransactions:async(account,start,end)=>structuredClone(rows.filter(r=>r.account===account&&r.date>=start&&r.date<=end&&!r.is_child).map(r=>({...r,...(r.is_parent?{subtransactions:rows.filter(c=>c.parent_id===r.id)}:{})}))),
    createAccount:async f=>{const id='account-'+ ++serial;accounts.push({...f,id});payees.push({id:'transfer-'+id,name:'Transfer: '+f.name,transfer_acct:id});writes.push({createAccount:f.name});return id;},
    addTransactions:async(account,txns)=>{
      writes.push({add:structuredClone(txns)});
      for(const t of txns) {
        const id='txn-'+ ++serial, {subtransactions,...fields}=t;
        let payee=payees.find(p=>p.name===t.payee_name);
        if (!payee) {payee={id:'payee-'+ ++serial,name:t.payee_name};payees.push(payee);}
        rows.push({...fields,id,account,payee:payee.id,is_parent:!!subtransactions});
        for(const sub of subtransactions || []) {
          const child={...sub,id:'child-'+ ++serial,account,date:t.date,is_child:true,parent_id:id};rows.push(child);
          const dest=payees.find(p=>p.id===sub.payee)?.transfer_acct;
          if (dest) {const other={id:'other-'+ ++serial,account:dest,date:t.date,amount:-sub.amount,payee:'transfer-'+account,transfer_id:child.id};child.transfer_id=other.id;rows.push(other);}
        }
      }
    },
    deleteTransaction:async id=>{
      writes.push({delete:id});if(failDelete)throw Error('delete failed');
      const ids=new Set([id,...rows.filter(r=>r.parent_id===id).map(r=>r.id)]);
      rows.filter(r=>ids.has(r.id)&&r.transfer_id).forEach(r=>ids.add(r.transfer_id));
      for(let i=rows.length-1;i>=0;i--)if(ids.has(rows[i].id))rows.splice(i,1);
    },
    updateTransaction:async(id,f)=>{Object.assign(rows.find(r=>r.id===id),f);writes.push({update:id});},
    createPayee:async f=>{const id='payee-'+ ++serial;payees.push({...f,id});return id;},
  };
  let saved=0;
  const bot=vm.createContext({console,structuredClone,ToolError,api,currentMessage:()=>undefined,checkpointMessage:()=>{},
    cfg:{defaults:{splitPerson:'Tia',fallbackCategory:'General',currency:'CAD',autoSplit:{'Shared Shop':'Tia'}}},
    cardmap:{aliases:{wealthsimple:'Wealthsimple VIP'},byLast4:{1234:'Wealthsimple VIP'},owners:{'Tia Mastercard':'Tia'}},
    OWED_FMT:'Owed by {name}', ACCT:{},CAT:{},TRANSFER_PAYEE:{},ACCOUNTS:accounts,
    CAT_RULES:[[/winners|home/i,'Home']], SPLIT_RE:/\bsplit\b|half|\/2/i,
    lastTxn:{},msgTxn:{},saveCardmap:()=>saved++,persistTxns:()=>saved++,
  });
  vm.runInContext(['cap','owedAccountFor','NON_NAMES','PRONOUNS','GENERIC_CARD_WORDS','personName','namesList','extractPerson','extractPersons','extractPaid','stripControlWords','parseCaption','guessCategory','maybeAutoSplit','resolveAccount','ownerOf','lastSplitPerson','rememberSplitPerson',
    'refreshActualMaps','resolvePayeeId','resolveOwedAccount','resolveOwedAccounts','splitAmounts','logExpense','logOwnerPaid','purgeLegs','rebindTxn',
    'agentReceiptContext','readAgentReceipt','prepareAgentReceipt','executeAgentReceipt','prepareCardMemory','applyCardMemory','refreshReceiptLinks'].map(declaration).join('\n'),bot);
  const receipts={state:()=>({cardmap:bot.cardmap,defaults:bot.cfg.defaults}),context:bot.agentReceiptContext,read:bot.readAgentReceipt,
    prepare:bot.prepareAgentReceipt,execute:bot.executeAgentReceipt,prepareMemory:bot.prepareCardMemory,saveMemory:bot.applyCardMemory};
  const tools=createActualTools(api,{receipts});
  const stage=(fields,options={})=>tools.prepare('propose_receipt_change',{action:'create',fields:{account:'card',date:'2026-09-12',amount:1694,merchant:'Winners 339',notes:'Nellies dishwashing powder, 80 scoops 1kg',...fields},...options});
  const apply=async plan=>{await tools.validate(plan);const refs={};const completed=[];for(const op of plan)completed.push({result:await tools.execute(op,refs)});await bot.refreshReceiptLinks(42,{completed});return completed.at(-1).result;};
  return {api,accounts,categories,payees,rows,writes,bot,tools,stage,apply,saved:()=>saved,failDelete:()=>failDelete=true};
}

test('agent receipt shares use the legacy writer, exact cents, one confirmation and no note substitution',async()=>{
  const f=fixture();const plan=await f.stage({splitPersons:['Tia']});
  assert.deepEqual(f.writes,[]);assert.equal(f.saved(),0);
  assert.match(plan[0].preview,/Your share: \$8\.47 → Home/);assert.match(plan[0].preview,/Tia: \$8\.47 → Owed by Tia/);
  assert.match(plan[0].preview,/Create on-budget account: Owed by Tia/);
  const result=await f.apply(plan);const root=f.rows.find(r=>r.id===result.id);
  assert.equal(root.amount,-1694);assert.equal(root.cleared,false);assert.equal(root.notes,'Nellies dishwashing powder, 80 scoops 1kg');
  const children=f.rows.filter(r=>r.parent_id===root.id);
  assert.deepEqual(children.map(r=>r.amount),[-847,-847]);assert.equal(children[0].category,'home');
  const debt=f.rows.find(r=>r.transfer_id===children[1].id);assert.equal(debt.amount,847);
  assert.equal(f.bot.lastTxn[42].id,root.id);
});

test('multi-person rounding and merchant auto-split defaults are shared',async()=>{
  const f=fixture();const plan=await f.stage({amount:1000,splitPersons:['Tia','Sam']});await f.apply(plan);
  assert.deepEqual(f.rows.filter(r=>r.is_child).map(r=>r.amount),[-334,-333,-333]);
  const auto=fixture();await auto.apply(await auto.stage({merchant:'Shared Shop'}));assert.deepEqual(auto.rows.filter(r=>r.is_child).map(r=>r.amount),[-847,-847]);
  const no=fixture();await no.apply(await no.stage({merchant:'Shared Shop',splitPersons:[]}));assert.ok(no.rows.every(r=>!r.is_child));
});

test('saved card owner chooses correct debt direction and half/mine/theirs amounts',async()=>{
  for(const [share,expected]of [['half',847],['mine',1694],['theirs',0]]){
    const f=fixture();await f.apply(await f.stage({account:'tia-card',share}));
    assert.equal(f.rows.find(r=>r.account==='tia-card').amount,-1694);
    const debt=f.rows.find(r=>r.account!=='tia-card');assert.equal(debt?.amount || 0,expected ? -expected : 0);
    if(debt)assert.equal(debt.category,'home');assert.ok(f.rows.every(r=>!r.is_child));
  }
  const f=fixture();await assert.rejects(f.stage({account:'tia-card'}),/your share/);assert.deepEqual(f.writes,[]);
});

test('split, unsplit and payer edits replace all linked entries and keep reply links',async()=>{
  const f=fixture();const first=await f.apply(await f.stage({}));f.bot.msgTxn['42:99']=f.bot.lastTxn[42];
  const split=await f.tools.prepare('propose_receipt_change',{action:'update',id:first.id,fields:{splitPersons:['Tia']}});
  const second=await f.apply(split);assert.equal(f.bot.msgTxn['42:99'].id,second.id);assert.equal(f.rows.filter(r=>r.is_parent).length,1);
  const unsplit=await f.tools.prepare('propose_receipt_change',{action:'update',id:second.id,fields:{splitPersons:[]}});
  const third=await f.apply(unsplit);assert.equal(f.rows.length,1);assert.equal(f.rows[0].category,'home');
  const paid=await f.tools.prepare('propose_receipt_change',{action:'update',id:third.id,fields:{account:'tia-card',paidBy:'Tia',share:'half'}});
  const fourth=await f.apply(paid);assert.equal(f.rows.length,2);assert.equal(f.bot.msgTxn['42:99'].id,fourth.id);
  const del=await f.tools.prepare('propose_receipt_change',{action:'delete',id:fourth.id});await f.apply(del);
  assert.equal(f.rows.length,0);assert.equal(f.bot.msgTxn['42:99'],undefined);
});

test('card alias, last four, owner and partner memory are staged and visible after confirmation',async()=>{
  const f=fixture();const plan=await f.tools.prepare('propose_card_memory_change',{account:'tia-card',alias:'Theos Mastercard',last4:'5602',owner:'Theo',splitPerson:'Theo'});
  assert.equal(f.saved(),0);assert.equal(f.bot.cardmap.byLast4['5602'],undefined);await f.apply(plan);
  const context=await f.tools.read('get_receipt_context',{last4:'5602'});
  assert.equal(context.account.id,'tia-card');assert.equal(context.account.owner,'Theo');assert.equal(context.usualSplitPerson,'Theo');
  assert.equal((await f.tools.read('get_receipt_context',{card:'theos mastercard'})).account.id,'tia-card');
});

test('confirming a receipt also remembers its selected card mapping, not before',async()=>{
  const f=fixture();const plan=await f.stage({last4:'5602',cardAlias:'Theo Card'});
  assert.equal(f.bot.cardmap.byLast4['5602'],undefined);assert.match(plan[0].preview,/5602/);
  await f.apply(plan);assert.equal(f.bot.cardmap.byLast4['5602'],'Wealthsimple VIP');assert.equal(f.bot.cardmap.aliases['theo card'],'Wealthsimple VIP');
});

test('receipt-scoped messages cannot fall back to a generic note-only transaction mutation',async()=>{
  const f=fixture();let turn=0;
  const agent=createAgent({tools:f.tools,allowedChatId:42,generate:async request=>{
    assert.ok(!request.declarations.some(d=>d.name==='propose_transaction_changes'));
    return {role:'model',parts:++turn===1?[{functionCall:{name:'propose_receipt_change',args:{action:'create',fields:{account:'card',date:'2026-09-12',amount:1694,merchant:'Winners 339',splitPersons:['Tia']}}}}]:[{text:'Ready'}]};
  }});
  const result=await agent.message(42,'Split with Tia',{receiptScope:true});assert.ok(result.planId);assert.deepEqual(f.writes,[]);
  await agent.cancel(42,result.planId);assert.deepEqual(f.writes,[]);assert.equal(f.saved(),0);
});

test('partial owner-paid writes are uncertain and never replayed on another confirmation',async()=>{
  const f=fixture();let turn=0,writes=0;const add=f.api.addTransactions;
  f.api.addTransactions=async(...args)=>{if(++writes===2)throw Error('lost connection');return add(...args);};
  const agent=createAgent({tools:f.tools,allowedChatId:42,generate:async()=>({role:'model',parts:++turn===1?[{functionCall:{name:'propose_receipt_change',args:{action:'create',fields:{account:'tia-card',date:'2026-09-12',amount:1694,merchant:'Winners 339',share:'half'}}}}]:[{text:'Ready'}]})});
  const p=await agent.message(42,'Log it, Tia paid, half mine',{receiptScope:true});assert.ok(p.planId);
  const done=await agent.confirm(42,p.planId);assert.match(done.text,/partially applied/);assert.equal(f.rows.filter(r=>r.account==='tia-card').length,1);
  await agent.confirm(42,p.planId);assert.equal(writes,2);assert.equal(f.rows.filter(r=>r.account==='tia-card').length,1);
});

test('stale children or card ownership invalidate the plan before writes',async()=>{
  const f=fixture();const created=await f.apply(await f.stage({splitPersons:['Tia']}));
  const plan=await f.tools.prepare('propose_receipt_change',{action:'update',id:created.id,fields:{splitPersons:[]}});
  f.rows.find(r=>r.is_child).amount=-800;
  const before=f.writes.length;await assert.rejects(f.tools.validate(plan),/changed/);assert.equal(f.writes.length,before);
  const g=fixture();const draft=await g.stage({splitPersons:['Tia']});g.bot.cardmap.owners['Wealthsimple VIP']='Sam';await assert.rejects(g.tools.validate(draft),/changed/);assert.deepEqual(g.writes,[]);
});

test('delete failure stops rebuild, missing transfer payee never becomes a note-only split',async()=>{
  const f=fixture();const r=await f.apply(await f.stage({}));const plan=await f.tools.prepare('propose_receipt_change',{action:'update',id:r.id,fields:{splitPersons:['Tia']}});
  f.failDelete();await assert.rejects(f.apply(plan),/delete failed/);assert.equal(f.rows.filter(t=>t.account==='card').length,1);
  const g=fixture();await g.bot.refreshActualMaps();await assert.rejects(g.bot.logExpense({accountName:'Wealthsimple VIP',total:16.94,payee:'Shop',notes:'',category:'Home',date:'2026-09-12',split:true,splitPersons:['Tia'],splitAccounts:['Missing']}),/transfer payee/);assert.deepEqual(g.writes,[]);
});

test('generic date edits refresh, rather than erase, unrelated and targeted receipt links',async()=>{
  const f=fixture();const a=await f.apply(await f.stage({}));f.bot.msgTxn['42:1']=f.bot.lastTxn[42];
  const b=await f.apply(await f.stage({merchant:'Another Shop',amount:100}));f.bot.msgTxn['42:2']=f.bot.lastTxn[42];
  await f.api.updateTransaction(a.id,{date:'2026-09-08'});await f.bot.refreshReceiptLinks(42,{completed:[]});
  assert.equal(f.bot.msgTxn['42:1'].date,'2026-09-08');assert.equal(f.bot.msgTxn['42:2'].id,b.id);
});

test('payer-to-own-card changes clear old leg IDs and preserve cleared status',async()=>{
  const f=fixture();const first=await f.apply(await f.stage({account:'tia-card',share:'half'}));
  f.rows.find(r=>r.account==='tia-card').cleared=true;
  const result=await f.apply(await f.tools.prepare('propose_receipt_change',{action:'update',id:first.id,fields:{account:'card',paidBy:null,splitPersons:['Tia']}}));
  assert.equal(result.receipt.cardTxnId,undefined);assert.equal(result.receipt.owedTxnId,undefined);
  assert.equal(f.rows.find(r=>r.id===result.id).cleared,true);
  assert.ok(!f.rows.some(r=>r.account==='tia-card'));
});

test('ordinary receipt edits preserve transaction IDs, cleared state and import metadata',async()=>{
  const f=fixture();const first=await f.apply(await f.stage({}));const row=f.rows.find(r=>r.id===first.id);row.cleared=true;row.reconciled=true;
  const imported=row.imported_id;
  const plan=await f.tools.prepare('propose_receipt_change',{action:'update',id:first.id,fields:{date:'2026-09-08',notes:'New note',merchant:'Updated Shop'}});
  const result=await f.apply(plan);assert.equal(result.id,first.id);assert.equal(row.imported_id,imported);assert.equal(row.cleared,true);assert.equal(row.reconciled,true);
  assert.equal(row.date,'2026-09-08');assert.equal(row.notes,'New note');assert.ok(!f.writes.some(w=>w.delete));
});

test('same-plan owner memory informs receipt planning; cancellation writes nothing',async()=>{
  const f=fixture();const memory=await f.tools.prepare('propose_card_memory_change',{account:'card',owner:'Theo'});
  const receipt=await f.tools.prepare('propose_receipt_change',{action:'create',fields:{account:'card',date:'2026-09-12',amount:1001,merchant:'Shop',share:'half'}},memory);
  assert.equal(receipt[0].recipe.rec.person,'Theo');assert.equal(receipt[0].recipe.rec.owedCents,501);
  assert.equal(f.saved(),0);assert.deepEqual(f.writes,[]);
  await f.apply([...memory,...receipt]);assert.equal(f.rows.find(r=>r.account==='card').amount,-1001);
  assert.equal(f.rows.find(r=>r.account!=='card').amount,-501);
});

test('duplicate receipts, invalid amounts and invalid partners never write a second charge',async()=>{
  const f=fixture();await assert.rejects(f.stage({amount:16.94}),ToolError);await assert.rejects(f.stage({splitPersons:['Tia','tia']}),/only once/);
  await assert.rejects(f.stage({splitPersons:['she']}),/person/);
  const plan=await f.stage({});await assert.rejects(f.tools.validate([...plan,...structuredClone(plan)]),/twice/);
  await f.apply(plan);const count=f.writes.length;await assert.rejects(f.apply(await f.stage({})),/already logged/);assert.equal(f.writes.length,count);
});

test('receipt tool can depend on one new account and the whole plan applies only once',async()=>{
  const f=fixture();let turn=0;
  const generate=async()=>({role:'model',parts:++turn===1?[{functionCall:{name:'propose_account_change',args:{action:'create',fields:{name:'New Card'},ref:'newcard'}}}]:turn===2?[{functionCall:{name:'propose_receipt_change',args:{action:'create',fields:{account:'$newcard',date:'2026-09-12',amount:1694,merchant:'Winners 339',splitPersons:['Tia']}}}}]:[{text:'Ready'}]});
  const agent=createAgent({tools:f.tools,generate,allowedChatId:42});const result=await agent.message(42,'Create New Card and log the split receipt',{requireReceipt:true});
  assert.ok(result.planId);assert.deepEqual(f.writes,[]);const done=await agent.confirm(42,result.planId);assert.match(done.text,/Applied 2/);
  const count=f.writes.length;await agent.confirm(42,result.planId);assert.equal(f.writes.length,count);
  assert.equal(f.rows.filter(r=>r.is_parent).length,1);
});

test('live model chooses receipt split tool, not a note or generic transaction', {skip:process.env.BORTON_LIVE_SMOKE !== '1'},async()=>{
  const f=fixture();const agent=createAgent({tools:f.tools,allowedChatId:42,planOnly:true,timeoutMs:180000,
    generate:createGeminiGenerate({apiKey:process.env.GOOGLE_API_KEY,models:JSON.parse(process.env.BORTON_SMOKE_MODELS || '["gemini-flash-latest"]')})});
  const result=await agent.message(42,'Split with Tia. This is an unlogged receipt: Winners 339, CAD 16.94, Wealthsimple VIP, Home, 2026-09-12, Nellies dishwashing powder, 80 scoops 1kg.');
  const plan=agent.pending(42);assert.ok(plan,result.text);const op=plan.operations.find(o=>o.domain==='receipt');assert.ok(op,result.text);
  assert.equal(op.recipe.rec.total,16.94);assert.equal(op.recipe.rec.split,true);assert.deepEqual(Array.from(op.recipe.rec.persons),['Tia']);assert.match(op.preview,/\$8\.47/);assert.deepEqual(f.writes,[]);
});
