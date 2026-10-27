// Public demo: real renderer, fictional writer-validated data, no live MCP bridge.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { demoFixtures } from './demo-fixtures.mjs';
const fixtures = await demoFixtures();
// Keep the installed renderer's copy. Only simulated delivery needs different
// wording: the public demo must never claim that a real chat was sent.
const demoCopy = new Map([
  ['Sending your reply…', 'Preparing your sample reply…'],
  ['Sent to the chat. Waiting for the agent to record your reply.', 'Sample reply captured. No chat was sent.'],
]);
const stub = {
  name:'demo-host',
  setup(builder) {
    builder.onLoad({filter:/[\\/]src[\\/]app\.mjs$/},async args=>{
      let source=await readFile(args.path,'utf8');
      for(const [original,translation] of demoCopy) {
        if(!source.includes(original)) throw new Error('Public demo copy no longer matches the renderer');
        source=source.replaceAll(original,translation);
      }
      return {contents:source,loader:'js'};
    });
    // Only the fictional bundle receives this isolated lock adapter. Native
    // renderer builds still require the browser's real Web Locks API.
    builder.onLoad({filter:/[\\/]src[\\/]reply-ui\.mjs$/},async args=>{
      let source=await readFile(args.path,'utf8');
      const original='this.lockManager = globalThis.navigator?.locks;';
      if(!source.includes(original)) throw new Error('Public demo coordination adapter no longer matches the renderer');
      source=source.replace(original,'this.lockManager = globalThis.DemoLocks;');
      return {contents:source,loader:'js'};
    });
    builder.onResolve({filter:/^@/},args=>({path:args.path,namespace:'demo'}));
    builder.onLoad({filter:/.*/,namespace:'demo'},args=>({contents:args.path.includes('mcp-extensions')
      ? 'export const OpenAIExtensions=globalThis.DemoExtensions;'
      : 'export const App=globalThis.DemoApp; export const applyDocumentTheme=theme=>{document.documentElement.style.colorScheme=theme;}; export const applyHostStyleVariables=()=>{};'}));
  },
};
const bundle=await build({entryPoints:['src/app.mjs'],bundle:true,format:'iife',write:false,minify:true,plugins:[stub]});
const data=JSON.stringify(fixtures).replace(/</g,'\\u003c');
const bridge=`
const fixtures=${data};let active;let app;
// The sandbox has no origin storage. Keep fictional drafts in this page only.
const demoDrafts=new Map();
Object.defineProperty(window,'localStorage',{value:{getItem:key=>demoDrafts.get(key)??null,setItem:(key,value)=>demoDrafts.set(key,String(value)),removeItem:key=>demoDrafts.delete(key),key:index=>[...demoDrafts.keys()][index]??null,get length(){return demoDrafts.size;}}});
// Fictional messages and storage belong to this single isolated frame only.
const demoLockQueues=new Map();
globalThis.DemoLocks={request(name,options,callback){
  const pending=(demoLockQueues.get(name)??Promise.resolve()).then(callback);
  demoLockQueues.set(name,pending.catch(()=>{}));
  return pending;
}};
globalThis.DemoApp=class{
  constructor(){app=this;}
  async connect(){}
  getHostContext(){return {theme:'dark'};}
  async callServerTool(request){
    if(request.name==='journal_mark_read'){
      const args=request.arguments,card=active.cards.find(item=>item.id===args.card_id);
      const event=[...active.history].reverse().find(entry=>entry.changes.some(change=>change.collection==='cards'&&change.id===args.card_id));
      if(args.conversation_id!==active.conversation_id||!card||!['qa','note','completion'].includes(card.type))throw Error('Invalid fictional read target');
      if(card.status==='resolved'&&card.resolution?.record_revision===args.record_revision&&
        card.resolution.source==='app:journal_mark_read:'+card.id+':'+args.record_revision)return {structuredContent:{journal:active}};
      if(event?.revision!==args.record_revision||!['open','answered'].includes(card.status))throw Error('The fictional card changed');
      const before=structuredClone(card),next=structuredClone(active),saved=next.cards.find(item=>item.id===card.id);
      saved.status='resolved';saved.resolution={actor:'user',source:'app:journal_mark_read:'+card.id+':'+args.record_revision,
        note:'Marked as read in Request Tracker.',record_revision:args.record_revision};
      if(saved.attention?.state==='acknowledged')saved.attention=null;
      next.revision++;
      next.history.push({revision:next.revision,turn_id:next.turn.id,changes:[
        {collection:'cards',id:card.id,before,after:structuredClone(saved)},
        {collection:'turn',id:next.turn.id,before:structuredClone(next.turn),after:structuredClone(next.turn)}]});
      active=next;
    }else if(request.name!=='journal_read')throw Error('Unsupported fictional tool');
    return {structuredContent:{journal:active}};
  }
};
globalThis.DemoExtensions=class{
  constructor(){this.message={send:async payload=>{
    const prose=payload.content.filter(item=>item.type==='text').map(item=>item.text).join('\\n');
    document.getElementById('demo-reply').textContent=prose;
    document.getElementById('demo-result').hidden=false;
    return {};
  }};}
};
function loadScenario(name){
  document.getElementById('demo-result').hidden=true;
  active=structuredClone(fixtures[name]);
  app.ontoolresult({structuredContent:{journal:active}});
}
window.addEventListener('load',()=>{
  const allowed=['open','later','reopened','closed'];
  const selected=document.querySelector('meta[name="request-journal-demo-scenario"]').getAttribute('content');
  const initial=allowed.includes(selected)?selected:'open';
  loadScenario(initial);
  const selector=document.getElementById('demo-scenario');
  for(const option of selector.querySelectorAll('option')) option.toggleAttribute('selected',option.value===initial);
  selector.addEventListener('change',event=>{
    const scenario=event.target.value;
    if(allowed.includes(scenario)) window.parent.postMessage({type:'request-journal-demo-scenario',scenario},'*');
  });
});
`;
const code=(bridge+'\n'+bundle.outputFiles[0].text).replace(/<\/script/gi,'<\\/script');
// HTML parsers normalize CRLF before enforcing hashes, including on Windows.
let html=(await readFile('src/app.html','utf8')).replace(/\r\n?/g,'\n');
html=html.replace('/* JOURNAL_SCRIPT */',()=>code);
const extraStyles='html{color-scheme:dark}body{max-width:840px;margin:auto;background:#17191d;color:#edf0f5;font:14px/1.5 system-ui}.demo-bar{margin:8px 0 16px;padding:14px;border:1px solid #454a55;border-radius:8px}.demo-bar p{margin:4px 0 12px}.demo-bar select{font:inherit;color:inherit;background:#202124;border:1px solid #69717f;padding:6px 10px;border-radius:6px;max-width:100%}.demo-result{padding:12px;margin:12px 0;border:1px solid #69717f;border-radius:8px}.demo-result pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.demo-bar label{margin-right:8px}';
html=html.replace('</style>','\n'+extraStyles+'</style>');
html=html.replace('<body>',`<body><aside class="demo-bar"><strong>Interactive demo</strong><p>Fictional conversation. Try a reply below, then switch example moments to see how the saved journal changes.</p><label for="demo-scenario">Example moment</label><select id="demo-scenario"><option value="open">1. A request branches</option><option value="later">2. You choose Later</option><option value="reopened">3. The obstacle matters again</option><option value="closed">4. The preview is complete</option></select><section id="demo-result" class="demo-result" hidden><strong>Your sample reply</strong><p>Nothing was sent to an agent. To see an example of the saved result, select moment 2 (Later) or 4 (Complete) above.</p><pre id="demo-reply"></pre></section></aside>`);
const hash=text=>"'sha256-"+createHash('sha256').update(text).digest('base64')+"'";
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const scriptHash=hash(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const csp="default-src 'none'; script-src "+scriptHash+"; style-src "+hash(css)+"; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
html=html.replace('<meta charset="utf-8">','<meta charset="utf-8"><meta name="request-journal-demo-scenario" content="open"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="referrer" content="no-referrer">');
// Script-only sandbox: no host API, same-origin access, popups or parent navigation.
const escapeAttr=text=>text.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// The opaque-origin child sends only a scenario key. Reloading its srcdoc gives
// each fixed snapshot a fresh renderer and draft map without changing revisions.
const parentScript=`
const frame=document.getElementById('demo-frame');
const template=frame.getAttribute('srcdoc');
const allowed=new Set(['open','later','reopened','closed']);
window.addEventListener('message',event=>{
  const data=event.data;
  if(event.source!==frame.contentWindow||!data||data.type!=='request-journal-demo-scenario'||!allowed.has(data.scenario)) return;
  frame.setAttribute('srcdoc',template.replace('<meta name="request-journal-demo-scenario" content="open">','<meta name="request-journal-demo-scenario" content="'+data.scenario+'">'));
});
`.replace(/\r\n?/g,'\n');
const output='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src '+scriptHash+' '+hash(parentScript)+'; frame-src about:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>Request Tracker demo</title><style>html,body{margin:0;height:100%;background:#17191d}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe id="demo-frame" title="Request Tracker — fictional interactive demo" sandbox="allow-scripts" srcdoc="'+escapeAttr(html)+'"></iframe><script>'+parentScript+'</script></body></html>';
await mkdir('docs-site/public',{recursive:true});
await writeFile('docs-site/public/demo.html',output);
console.log('Built public demo from src/app.mjs using fictional records; live messaging and network access are disabled.');
