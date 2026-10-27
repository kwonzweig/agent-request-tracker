// Fictional examples pass through the real journal writer. Never read user storage.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateJournal } from '../src/store.mjs';

export async function demoFixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'request-journal-demo-'));
  const conversation = 'fictional-weekly-digest';
  let revision = 0;
  async function save(id, summary, upsert, end_reason = null) {
    const state = await updateJournal(dir, conversation, {
      expected_revision: revision,
      turn: { id, source: 'fictional:' + id, summary, end_reason },
      upsert,
    });
    revision = state.revision;
    return state;
  }
  try {
    const open = await save('T1', 'The layout is ready. Choose how to group the preview; inbox access can wait.', {
      requests: [
        { id:'R1', parent_id:null, title:'Build my weekly reading digest', status:'active', origin:'user', source:'fictional:user:1',
          done_when:['Summarize the newsletters I choose','Preview the digest before sending anything'],
          workspace:{ id:'DEMO-42', url:'https://example.com/work/42' } },
        { id:'R2', parent_id:'R1', title:'Draft the digest layout', status:'done', origin:'user', source:'fictional:user:1',
          done_when:['A short summary and source link for each story'], evidence:'Fictional example: preview layout reviewed.' },
      ],
      decisions:[{ id:'D1', request_id:'R1', revision:1, question:'Which schedule should the digest preview use?',
        why:'Pick daily summaries or a weekly roundup. This changes the preview only.', required:true,
        options:[{id:'friday',label:'Friday morning',impact:'Preview one roundup for the end of the week.'},{id:'daily',label:'Every morning',impact:'Preview shorter daily summaries.'}],
        recommendation:'friday', no_answer_behavior:'Wait before finalizing the preview. Email stays off.', status:'open', source:'fictional:agent:1' }],
      blockers:[{ id:'B1',request_id:'R1',title:'Connect the newsletter inbox',evidence:'No newsletter source is available yet. The agent needs the inbox connection or a file you provide.',
        next_action:'Connect the inbox, or use a file you provide.',owner:'user',status:'open',revision:1,source:'fictional:agent:1',
        action_url:'https://example.com/connect',
        options:[{id:'file',label:'Use an exported file',impact:'Work from the file for this digest. Leave the inbox disconnected.'}] }],
      cards:[{id:'Q1',request_id:'R1',revision:1,type:'qa',title:'Will this send email without asking?',
        body:'No. This request covers preparing a preview. Sending the digest needs a separate approval.',source:'fictional:agent:1',status:'answered'}],
    },'decision');
    const later = await save('T2','The inbox can wait. The preview still needs your schedule choice before it can be finalized.',{
      replies:[{id:'demo-later',source:'fictional:user:later',items:[{collection:'blockers',id:'B1',record_revision:1,kind:'defer',outcome:'accepted'}]}],
      blockers:[{id:'B1',attention:{state:'later',actor:'user',source:'fictional:user:later'}}],
    },'decision');
    const reopened = await save('T3','The sample layout is finished. Real newsletter summaries now need a source.',{
      blockers:[{id:'B1',attention:{state:'pending',actor:'agent',source:'fictional:dependency:source-needed',reason:'The layout is ready; summarizing your real newsletters needs the inbox or an exported file.'},
        nudge:{text:'Ready for your newsletters. Connect the inbox or choose the file option.',priority:'high'}}],
    },'blocker');
    const closed = await save('T4','Your Friday preview is ready. No email was scheduled or sent.',{
      requests:[{id:'R1',status:'done',evidence:'Fictional example: the selected newsletters from the user-supplied export were summarized into a Friday digest preview, with a short summary and source link for each story. The preview was shown to the user before any delivery; no email was scheduled or sent.'}],
      decisions:[{id:'D1',status:'answered',user_answer:{revision:1,option_id:'friday',source:'fictional:user:4',text:'Friday. Use my exported file for now; do not send anything.'}}],
      blockers:[{id:'B1',status:'dismissed',dismissal:{actor:'agent',source:'fictional:user:4',reason:'The user supplied an exported file. The inbox is unnecessary for this draft.'}}],
      cards:[{id:'Q1',status:'resolved',resolution:{actor:'user',source:'fictional:user:4',note:'The user confirmed that the digest should remain a preview.'}}],
    },'complete');
    return {open,later,reopened,closed};
  } finally {
    // dir is a fresh mkdtemp result owned by this invocation, never a user path.
    await rm(dir,{recursive:true,force:true});
  }
}
