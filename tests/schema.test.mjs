import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Ajv from 'ajv/dist/2020.js';
import {updateJournal,readJournal} from '../src/store.mjs';
test('published JSON Schema accepts actual writer output and rejects missing completion evidence',async t=>{
 const schema=JSON.parse(await readFile('schema/journal.schema.json','utf8'));
 const validate=new Ajv({strict:false}).compile(schema);
 assert.equal(validate(JSON.parse(await readFile('examples/journal.json','utf8'))),true,JSON.stringify(validate.errors));
 const dir=await mkdtemp(join(tmpdir(),'journal-schema-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.equal(validate(await readJournal(dir,'schema-test')),true,JSON.stringify(validate.errors));
 const saved=await updateJournal(dir,'schema-test',{expected_revision:0,turn:{id:'T1',source:'user:1',summary:'Capture request',end_reason:null},upsert:{requests:[{id:'R1',title:'Finish requested outcome',done_when:'Verified output',source:'user:1',status:'active',parent_id:null}]}});
 assert.equal(validate(saved),true,JSON.stringify(validate.errors));
 const invalid=structuredClone(saved);invalid.requests[0].status='done';
 assert.equal(validate(invalid),false);
});

test('Blocker schema allows an omitted action URL or an absolute HTTP(S) URL',async()=>{
 const schema=JSON.parse(await readFile('schema/journal.schema.json','utf8'));
 const validate=new Ajv({strict:false}).compile({$defs:schema.$defs,$ref:'#/$defs/blocker'});
 const blocker={id:'B1',request_id:'R1',title:'Missing access',evidence:'tool:error:login-required',next_action:'Sign in',owner:'user',status:'open'};
 assert.equal(validate(blocker),true,JSON.stringify(validate.errors));
 for(const action_url of ['https://accounts.example.com/login?return_to=%2Fworkspace','http://localhost:3000/access']) {
  assert.equal(validate({...blocker,action_url}),true,JSON.stringify(validate.errors));
 }
 for(const action_url of ['javascript:alert(1)','data:text/html,hello','file:///tmp/access','ftp://example.com/access','/login','//example.com/login','not a URL','',null,42,'https://','https:///example.com/login',' https://example.com/login','https://example.com/log in','https://example.com/\\login','https://example.com/\nlogin']) {
  assert.equal(validate({...blocker,action_url}),false,JSON.stringify(action_url));
 }
});

test('optional card and receipt schema preserves version-1 compatibility and enforces type-specific shapes',async()=>{
 const schema=JSON.parse(await readFile('schema/journal.schema.json','utf8'));
 const ajv=new Ajv({strict:false});
 const validate=ajv.compile(schema);
 const old={schema_version:1,revision:0,conversation_id:'c',requests:[],decisions:[],blockers:[],turn:null,history:[]};
 assert.equal(validate(old),true,JSON.stringify(validate.errors));
 const card={id:'C1',request_id:'R1',revision:1,type:'suggestion',title:'Optional preference',body:'Keep working while considering it.',source:'agent:1',status:'open',options:[{id:'A',label:'A',impact:'First effect'}]};
 const receipt={id:'delivery-1',source:'user:received-1',items:[{collection:'cards',id:'C1',record_revision:1,kind:'answer',outcome:'accepted',option_id:'A'}]};
 const cardShape=ajv.compile({$defs:schema.$defs,$ref:'#/$defs/card'});
 const receiptShape=ajv.compile({$defs:schema.$defs,$ref:'#/$defs/reply'});
 assert.equal(cardShape(card),true,JSON.stringify(cardShape.errors));
 assert.equal(receiptShape(receipt),true,JSON.stringify(receiptShape.errors));
 assert.equal(validate({...old,cards:[card],replies:[receipt]}),true,JSON.stringify(validate.errors));
 const {options,...plain}=card;
 for(const type of ['qa','note']) {
  assert.equal(cardShape({...plain,type}),true,JSON.stringify(cardShape.errors));
  assert.equal(cardShape({...card,type}),false);
  assert.equal(cardShape({...plain,type,user_answer:null}),false);
 }
 for(const invalid of [{...card,revision:0},{...card,type:'task'},{...card,source:' '},{...card,options:[]}]) assert.equal(cardShape(invalid),false);
 for(const item of [{...receipt.items[0],outcome:undefined},{...receipt.items[0],outcome:'rejected'},{...receipt.items[0],record_revision:0},{collection:'requests',id:'R1',record_revision:1,kind:'comment',text:' '},{collection:'requests',id:'R1',record_revision:1,kind:'comment',outcome:'stale',text:'Original comment'}]) {
  assert.equal(receiptShape({...receipt,items:[item]}),false);
 }
 assert.equal(receiptShape({...receipt,items:[{...receipt.items[0],outcome:'stale'}]}),true);
 assert.equal(receiptShape({...receipt,items:[{collection:'requests',id:'R1',record_revision:1,kind:'comment',text:'Original comment'}]}),true);
 assert.equal(validate({...old,cards:null}),false);
 assert.equal(validate({...old,replies:null}),false);
});

test('published JSON schema validates cards and replies in actual writer history',async t=>{
 const schema=JSON.parse(await readFile('schema/journal.schema.json','utf8'));
 const validate=new Ajv({strict:false}).compile(schema);
 const dir=await mkdtemp(join(tmpdir(),'journal-cards-schema-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const turn={id:'T1',source:'user:1',summary:'Capture an optional preference',end_reason:null};
 await updateJournal(dir,'c',{expected_revision:0,turn,upsert:{requests:[{id:'R1',title:'Deliver outcome',done_when:'Verified output',source:'user:1',status:'active'}],cards:[{id:'C1',request_id:'R1',revision:1,type:'note',title:'Progress',body:'The original work continues.',source:'agent:1',status:'open'}]}});
 const saved=await updateJournal(dir,'c',{expected_revision:1,turn:{...turn,id:'T2'},upsert:{replies:[{id:'delivery-1',source:'user:received-1',items:[{collection:'cards',id:'C1',record_revision:1,kind:'comment',text:'Please retain that context.'}]}]}});
 assert.equal(validate(saved),true,JSON.stringify(validate.errors));
 const historyShape=new Ajv({strict:false}).compile({$defs:schema.$defs,$ref:'#/$defs/history'});
 for(const history of saved.history) assert.equal(historyShape(history),true,JSON.stringify(historyShape.errors));
});
