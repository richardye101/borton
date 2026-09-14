// Exercise the real receipt bridge and writers without Telegram or a real budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    'receiptSummary','agentReceiptContext','readAgentReceipt','prepareAgentReceipt','executeAgentReceipt','prepareCardMemory','applyCardMemory','refreshReceiptLinks'].map(declaration).join('\n'),bot);
  const receipts={state:()=>({cardmap:bot.cardmap,defaults:bot.cfg.defaults}),context:bot.agentReceiptContext,read:bot.readAgentReceipt,
    prepare:bot.prepareAgentReceipt,execute:bot.executeAgentReceipt,prepareMemory:bot.prepareCardMemory,saveMemory:bot.applyCardMemory};
  const tools=createActualTools(api,{receipts});
  const stage=(fields,options={})=>tools.prepare('propose_receipt_change',{action:'create',fields:{account:'card',date:'2026-09-12',amount:1694,merchant:'Winners 339',notes:'Nellies dishwashing powder, 80 scoops 1kg',...fields},...options});
  const apply=async plan=>{await tools.validate(plan);const refs={};const completed=[];for(const op of plan)completed.push({result:await tools.execute(op,refs)});await bot.refreshReceiptLinks(42,{completed});return completed.at(-1).result;};
  return {api,accounts,categories,payees,rows,writes,bot,tools,stage,apply,saved:()=>saved,failDelete:()=>failDelete=true};
}

function receiptUI(f, options = {}) {
  const messages=[],requests=[];
  f.nextMessageId ||= 100;
  const agent=createAgent({tools:f.tools,allowedChatId:42,allowedChatIds:[-42],
    generate:async()=>assert.fail('Receipt buttons must not call Gemini'),...options});
  Object.assign(f.bot,{
    Buffer,budgetAgent:agent,confirming:{},editField:{},pending:{},ownerPending:{},
    isHelperAccount:n=>n.startsWith('Owed by '),
    send:async(chat,text,keyboard)=>{const mid=f.nextMessageId++;messages.push({mid,chat,text,keyboard});return mid;},
    tg:async(method,params)=>{requests.push({method,params});if(method==='editMessageReplyMarkup') {const m=messages.find(m=>m.mid===params.message_id);if(m)m.keyboard=params.reply_markup;}return {ok:true};},
    dropKb:async(_chat,mid)=>{const m=messages.find(m=>m.mid===mid);if(m)m.keyboard=undefined;},
  });
  Object.assign(f.bot.cfg,{telegram:{allowedChatId:42,relayChannelId:-42},agent:{relayEnabled:true}});
  if(!f.bot.agentReceiptTarget) vm.runInContext(['isRelay','isAllowedChat','isOwner','agentFor','receiptFor','agentConfirmKb','loggedKb','fieldMenuKb','splitSubKb','catPickerKb','cardKb','ownerKb','resolveCategory','FIELD_LABEL',
    'sendAgentResult','agentReceiptTarget','stageReceiptButton','receiptFieldPatch','receiptCardChoice','agentReceiptButton','applyFieldValue','onCallback','dispatch'].map(declaration).join('\n'),f.bot);
  const tap=(data,mid,from=42,chat=42)=>f.bot.onCallback({id:'tap',data,from:{id:from},message:{chat:{id:chat},message_id:mid}});
  const start=async(fields={})=>{
    const p=await agent.receiptChange(42,{action:'create',fields:{account:'card',date:'2026-09-12',amount:1694,merchant:'Winners 339',notes:'Dishwashing powder',...fields}});
    await f.bot.sendAgentResult(42,p);return messages.at(-1);
  };
  const confirm=async()=>{const p=agent.pending(42);await tap(`ag:y:${p.id}`,p.messageId);return messages.at(-1);};
  return {agent,messages,requests,tap,start,confirm,last:()=>messages.at(-1)};
}

test('compact receipt preview and success restore the complete button menu and exact split',async()=>{
  const f=fixture(),ui=receiptUI(f),first=await ui.start();
  assert.match(first.text,/Log receipt\n\$16\.94 · Winners 339/);
  assert.ok(first.keyboard.inline_keyboard.flat().some(b=>b.text==='✏️ Edit'));
  await ui.tap('e:menu',first.mid);
  for(const label of ['Category','Merchant','Note','Card','Split','Paid by']) assert.ok(first.keyboard.inline_keyboard.flat().some(b=>b.text.includes(label)),label);
  await ui.tap('e:back',first.mid);assert.ok(first.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('ag:y:')));
  await ui.tap('e:sub:split',first.mid);
  const split=first.keyboard.inline_keyboard.flat().find(b=>b.text.includes('50/50'));
  assert.match(split.text,/Tia/);await ui.tap(split.callback_data,first.mid);
  assert.equal(f.writes.length,0);
  const revised=ui.last();assert.match(revised.text,/Your share: \$8\.47 → Home\nTia: \$8\.47 → Owed by Tia/);
  assert.match(revised.text,/Create on-budget account: Owed by Tia/);
  const logged=await ui.confirm();assert.match(logged.text,/^✅ Logged/);assert.match(logged.text,/Synced ✓/);
  assert.ok(logged.text.length<250,logged.text);
  assert.doesNotMatch(logged.text,/Applied|Create payee|Confirm applies/);
  assert.deepEqual(Array.from(logged.keyboard.inline_keyboard[0],b=>b.callback_data),['e:ok','e:menu','e:del']);
  assert.equal(f.bot.msgTxn[`42:${logged.mid}`].id,f.bot.lastTxn[42].id);
  await ui.tap('e:menu',logged.mid);await ui.tap('e:back',logged.mid);
  assert.ok(logged.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='e:del'));
  await ui.tap('e:ok',logged.mid);assert.equal(logged.keyboard,undefined);
});

test('buttons and typed replies revise one pending receipt, invalidate old confirms and do not call Gemini',async()=>{
  const f=fixture(),ui=receiptUI(f);const first=await ui.start();const oldId=ui.agent.pending(42).id;
  await ui.tap('e:set:note',first.mid);
  await f.bot.dispatch(42,{text:'Updated note'});
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.notes,'Updated note');
  assert.notEqual(ui.agent.pending(42).id,oldId);assert.equal(f.writes.length,0);
  await ui.tap(`ag:y:${oldId}`,first.mid);assert.equal(f.writes.length,0);
  const mid=ui.agent.pending(42).messageId;
  await ui.tap('e:sub:cat',mid);
  f.categories.reverse();await f.bot.refreshActualMaps();
  await ui.tap('ec:general',mid);
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.category,'General');
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.notes,'Updated note');
  await ui.confirm();assert.equal(f.rows[0].category,'general');assert.equal(f.rows[0].notes,'Updated note');
});

test('note edits preserve the previewed category and split defaults instead of guessing again',async()=>{
  const f=fixture(),ui=receiptUI(f);const m=await ui.start({merchant:'Shared Shop',notes:'home supplies'});
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.category,'Home');
  await ui.tap('e:set:note',m.mid);await f.bot.dispatch(42,{text:'coffee'});
  const rec=ui.agent.pending(42).operations[0].recipe.rec;
  assert.equal(rec.category,'Home');assert.equal(rec.notes,'coffee');assert.deepEqual(Array.from(rec.persons),['Tia']);
  await ui.tap('e:set:note',ui.last().mid);await f.bot.dispatch(42,{text:'Split with Tia is written on the box'});
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.notes,'Split with Tia is written on the box');
});

test('editing an older logged receipt targets its link, not the newest receipt, and deletion needs confirmation',async()=>{
  const f=fixture(),ui=receiptUI(f);await ui.start({merchant:'Older receipt'});const old=await ui.confirm();const oldId=f.bot.msgTxn[`42:${old.mid}`].id;
  await ui.start({merchant:'Newer receipt',amount:5000,category:'home'});await ui.confirm();const newerId=f.bot.lastTxn[42].id;
  const writes=f.writes.length;
  await ui.tap('ec:general',old.mid);assert.equal(f.writes.length,writes);assert.equal(ui.agent.pending(42).operations[0].id,oldId);
  await ui.confirm();assert.equal(f.rows.find(r=>r.id===oldId).category,'general');assert.equal(f.rows.find(r=>r.id===newerId).category,'home');
  await ui.tap('e:del',old.mid);assert.ok(f.rows.some(r=>r.id===oldId));
  await ui.confirm();assert.ok(!f.rows.some(r=>r.id===oldId));assert.ok(f.rows.some(r=>r.id===newerId));
  assert.equal(ui.last().keyboard,undefined);
});

test('card, payer, half/mine/theirs, split/unsplit and typed merchant controls stage complete changes',async()=>{
  const f=fixture(),ui=receiptUI(f);let message=await ui.start({splitPersons:['Tia']});
  await ui.tap('e:set:card',message.mid);assert.ok(message.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='ea:tia-card'));
  await ui.tap('ea:tia-card',message.mid);assert.ok(message.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='e:cardshare:tia-card:mine'));
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.account,'Wealthsimple VIP');
  await ui.tap('e:cardshare:tia-card:mine',message.mid);
  let r=ui.agent.pending(42).operations[0].recipe.rec;assert.equal(r.owedCents,1694);assert.equal(r.account,'Tia Mastercard');assert.equal(r.persons.length,0);
  await ui.tap('e:share:theirs',ui.last().mid);assert.equal(ui.agent.pending(42).operations[0].recipe.rec.owedCents,0);
  await ui.tap('e:paid:Tia',ui.last().mid);assert.equal(ui.agent.pending(42).operations[0].recipe.rec.owedCents,847);
  await ui.tap('ea:card',ui.last().mid);r=ui.agent.pending(42).operations[0].recipe.rec;assert.equal(r.ownerPaid,false);
  await ui.tap('e:set:split',ui.last().mid);await f.bot.dispatch(42,{text:'Tia and Sam'});
  assert.deepEqual(Array.from(ui.agent.pending(42).operations[0].recipe.rec.persons),['Tia','Sam']);
  await ui.tap('e:do:unsplit',ui.last().mid);assert.equal(ui.agent.pending(42).operations[0].recipe.rec.split,false);
  await ui.tap('e:set:merchant',ui.last().mid);await f.bot.dispatch(42,{text:'Renamed shop'});
  assert.equal(ui.agent.pending(42).operations[0].recipe.rec.payee,'Renamed shop');assert.equal(f.writes.length,0);
  await ui.confirm();assert.equal(f.rows.length,1);
});

test('receipt buttons enforce owner, chat, expired target and cancellation boundaries',async()=>{
  const f=fixture(),ui=receiptUI(f);const m=await ui.start(),p=ui.agent.pending(42);
  await ui.tap('e:paid:Tia',m.mid,999);assert.equal(ui.agent.pending(42).id,p.id);
  await ui.tap('e:paid:Tia',m.mid,42,-42);assert.equal(ui.agent.pending(42).id,p.id);
  await ui.tap('e:set:note',m.mid);await ui.tap(`ag:n:${p.id}`,m.mid);assert.equal(ui.agent.pending(42),null);
  assert.equal(f.bot.editField[42],undefined);
  await ui.tap('e:split:Tia',m.mid);assert.equal(ui.agent.pending(42),null);assert.equal(f.writes.length,0);
});

test('receipt confirmation bindings survive restart and sync/partial failures remain visible',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'borton-buttons-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture(),options={statePath:path.join(dir,'agent.json')},ui=receiptUI(f,options);const m=await ui.start();
  const restored=receiptUI(f,options);assert.equal(restored.agent.pending(42).messageId,m.mid);
  await restored.tap('e:split:Tia',m.mid);assert.ok(restored.agent.pending(42).operations[0].recipe.rec.split);assert.equal(f.writes.length,0);
  const receipt=await f.apply(await f.stage({merchant:'Synthetic completed receipt'}));
  const completed=[{preview:'Log receipt',result:{domain:'receipt',action:'create',receipt:receipt.receipt}}];
  await f.bot.sendAgentResult(42,{text:'full result',completed,uncertain:null,syncFailed:true});
  assert.match(restored.last().text,/cloud sync failed/);assert.doesNotMatch(restored.last().text,/Synced ✓/);
  await f.bot.sendAgentResult(42,{text:'Stopped: step may have partially applied',completed,uncertain:1,syncFailed:false});
  assert.match(restored.last().text,/partially applied/);assert.equal(restored.last().keyboard,undefined);
});

test('typed edit prompts persist across restart and still edit the original preview',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'borton-edit-prompt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture(),options={statePath:path.join(dir,'agent.json')},ui=receiptUI(f,options);const m=await ui.start();
  Object.assign(f.bot,{fs,TXN_STORE:path.join(dir,'links.json')});
  vm.runInContext(['persistTxns','loadTxns'].map(declaration).join('\n'),f.bot);
  await ui.tap('e:set:note',m.mid);
  const pendingId=ui.agent.pending(42).id;
  const restored=receiptUI(f,options);f.bot.loadTxns();
  assert.equal(f.bot.editField[42].planId,pendingId);
  await f.bot.dispatch(42,{text:'Resumed after restart'});
  assert.equal(restored.agent.pending(42).operations[0].recipe.rec.notes,'Resumed after restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.bot.TXN_STORE)).editField,{});assert.equal(f.writes.length,0);
});

test('receipt-button revisions preserve prerequisite operations and one confirmation',async()=>{
  const f=fixture();let round=0;
  const agent=createAgent({tools:f.tools,allowedChatId:42,generate:async()=>({role:'model',parts:round++ ? [{text:'Ready'}] : [
    {functionCall:{name:'propose_account_change',args:{action:'create',ref:'newcard',fields:{name:'New Card',offbudget:false}}}},
    {functionCall:{name:'propose_receipt_change',args:{action:'create',fields:{account:'$newcard',date:'2026-09-12',amount:1694,merchant:'Winners 339'}}}},
  ]})});
  const p=await agent.message(42,'Create New Card and log this receipt');
  const revised=await agent.receiptChange(42,{planId:p.planId,fields:{splitPersons:['Tia'],notes:'Revised'}});
  assert.equal(agent.pending(42).operations.length,2);assert.equal(f.writes.length,0);
  const done=await agent.confirm(42,revised.planId);assert.equal(done.uncertain,null);
  assert.equal(f.accounts.filter(a=>a.name==='New Card').length,1);
  assert.equal(f.rows.find(r=>r.is_parent).notes,'Revised');
  const writes=f.writes.length;await agent.confirm(42,revised.planId);assert.equal(f.writes.length,writes);
});

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
