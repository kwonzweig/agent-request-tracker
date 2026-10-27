import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { updateJournal } from '../src/store.mjs';

const checkpoint = { expected_revision: 0, turn: { id:'T1', source:'user:1', summary:'Implement requested tracker', end_reason:null }, upsert:{requests:[{id:'R1',parent_id:null,title:'Persistent tracker',done_when:'Actual native cards reflect saved changes',status:'active',source:'user:1'}]} };
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(),'journal-integration-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
async function hook(dir,event) {
  return await new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,['plugin/dist/hook.mjs'],{env:{...process.env,REQUEST_JOURNAL_DATA_DIR:dir},stdio:['pipe','pipe','pipe']});
    let out='',err=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>err+=d);
    child.on('error',reject); child.on('close',code=>code===0?resolveResult(out?JSON.parse(out):null):reject(new Error(err)));
    child.stdin.end(JSON.stringify(event));
  });
}

test('MCP saves, reloads after server restart, rejects stale writes, and serves app HTML',async t=>{
  const dir=await temp(t);
  async function connect() {
    const client=new Client({name:'request-journal-test',version:'1.0.0'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('plugin/dist/server.mjs')],env:{...process.env,REQUEST_JOURNAL_DATA_DIR:dir},stderr:'pipe'}));
    return client;
  }
  let client=await connect();
  try {
    const tools=await client.listTools();
    assert.deepEqual(tools.tools.map(t=>t.name).sort(),['journal_mark_read','journal_read','journal_show','journal_update']);
    assert.equal(tools.tools.find(t=>t.name==='journal_read')._meta?.ui,undefined);
    assert.deepEqual(tools.tools.find(t=>t.name==='journal_update')._meta.ui,{visibility:['model']});
    assert.deepEqual(tools.tools.find(t=>t.name==='journal_mark_read')._meta.ui,{visibility:['app']});
    for (const name of ['journal_read','journal_update','journal_mark_read']) assert.equal(tools.tools.find(t=>t.name===name)._meta?.['ui/resourceUri'],undefined);
    assert.equal(tools.tools.find(t=>t.name==='journal_show')._meta.ui.resourceUri,'ui://request-journal/tracker.html');
    const saved=await client.callTool({name:'journal_update',arguments:{conversation_id:'integration',...checkpoint}});
    assert.equal(saved.isError,undefined); assert.equal(saved.structuredContent.journal.revision,1);
    const shown=await client.callTool({name:'journal_show',arguments:{conversation_id:'integration'}});
    assert.deepEqual(shown.structuredContent.journal,saved.structuredContent.journal);
    const stale=await client.callTool({name:'journal_update',arguments:{conversation_id:'integration',...checkpoint}});
    assert.equal(stale.isError,true);
    const html=await client.readResource({uri:'ui://request-journal/tracker.html'});
    assert.equal(html.contents[0].mimeType,'text/html;profile=mcp-app');
    assert.match(html.contents[0].text,/Request Tracker/);
    assert.doesNotMatch(html.contents[0].text,/JOURNAL_SCRIPT/);
    await client.close(); client=await connect();
    const read=await client.callTool({name:'journal_read',arguments:{conversation_id:'integration'}});
    assert.equal(read.structuredContent.journal.requests[0].id,'R1');
    assert.equal(read.structuredContent.journal.revision,1);
  } finally { await client.close(); }
});

test('hooks affect enrolled conversations only, restore pending requests, and bound stop repair',async t=>{
  const dir=await temp(t), event={session_id:'enrolled',turn_id:'T1',hook_event_name:'Stop'};
  assert.equal(await hook(dir,event),null);
  await updateJournal(dir,'enrolled',checkpoint);
  const context=await hook(dir,{...event,hook_event_name:'UserPromptSubmit'});
  assert.match(context.hookSpecificOutput.additionalContext,/R1: Persistent tracker/);
  const first=await hook(dir,event); assert.equal(first.decision,'block');
  const repair=await hook(dir,{...event,stop_hook_active:true});
  assert.equal(repair.decision,undefined); assert.match(repair.systemMessage,/not completion/);
  await hook(dir,{...event,hook_event_name:'Interrupt'});
  assert.equal(await hook(dir,event),null);
  assert.equal((await hook(dir,{...event,turn_id:'T2'})).decision,'block');
  const missingTurn=await hook(dir,{...event,turn_id:undefined});
  assert.match(missingTurn.systemMessage,/cannot verify/);
  assert.equal(missingTurn.decision,undefined);
});
