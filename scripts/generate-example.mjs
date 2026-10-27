import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateJournal} from '../src/store.mjs';
const dir=await mkdtemp(join(tmpdir(),'journal-example-'));
try {
 await updateJournal(dir,'example-conversation',{expected_revision:0,turn:{id:'T1',source:'example:user:1',summary:'Illustrative request, not a real conversation',end_reason:null},upsert:{requests:[{id:'R1',parent_id:null,title:'Keep requests visible across turns',done_when:['Saved JSON persists across turns','Native cards display saved changes'],origin:'user',source:'example:user:1',status:'active'}],decisions:[{id:'D1',request_id:'R1',revision:1,question:'Which display should the first version use?',why:'Choose the initial user surface',options:[{id:'native',label:'Existing chat surface',impact:'Preserves JSON and cards without a separate app'},{id:'app',label:'Separate app',impact:'Adds an application to install and maintain'}],recommendation:'native',no_answer_behavior:'Continue authorized research; do not assume approval',required:false,status:'open',agent_assumption:null}]}});
 const final=await updateJournal(dir,'example-conversation',{expected_revision:1,turn:{id:'T2',source:'example:user:2',summary:'User selects native surface; implementation remains active',end_reason:null},upsert:{decisions:[{id:'D1',status:'answered',user_answer:{revision:1,option_id:'native',source:'example:user:2',text:'Use native cards, provided persistence remains.'}}]}});
 await writeFile('examples/journal.json',JSON.stringify(final,null,2)+'\n');
} finally {await rm(dir,{recursive:true,force:true});}
