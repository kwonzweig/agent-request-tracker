import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, previewState, commit, memoryStorage, tick } from './ui-harness.mjs';
const choice = (ui, option) => ui.document.querySelector(`#jc-attention [data-record="D1"][data-choice="${option}"]`);
const other = ui => ui.document.querySelector('#jc-attention [data-record="D1"] textarea');
function type(ui, field, value) { field.value = value; field.dispatchEvent(new ui.window.Event('input', { bubbles: true })); }
test('Send does not submit an unseen shared selection after its pre-send refresh', async () => {
  const storage = memoryStorage(), a = await view({ storage }), b = await view({ storage });
  a.show(state()); b.show(state()); choice(a, 'A').click(); await b.refresh(state());
  assert.equal(choice(b, 'A').getAttribute('aria-pressed'), 'true');
  choice(a, 'B').click();
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 0);
  assert.equal(choice(b, 'B').getAttribute('aria-pressed'), 'true');
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.equal(b.envelope().items[0].option_id, 'B');
});
test('Other typing conflict exposes current selection and retains text for deliberate re-selection', async () => {
  const storage = memoryStorage(), a = await view({ storage }), b = await view({ storage });
  a.show(state()); b.show(state()); choice(b, 'other').click();
  type(b, other(b), 'Keep my own route'); await a.refresh(state());
  choice(a, 'A').click();
  const oldEditor = other(b);
  type(b, oldEditor, 'Keep my own route!');
  assert.equal(choice(b, 'A').getAttribute('aria-pressed'), 'true');
  assert.equal(choice(b, 'other').getAttribute('aria-pressed'), 'false');
  type(b, oldEditor, 'Another keystroke');
  const reopened = await view({ storage }); reopened.show(state());
  assert.equal(choice(reopened, 'A').getAttribute('aria-pressed'), 'true');
  choice(b, 'other').click();
  assert.equal(other(b).value, 'Keep my own route!');
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.equal(b.envelope().items[0].text, 'Keep my own route!');
});

for (const editor of ['comment', 'other', 'queued']) test(`editing ${editor} cannot import an unseen choice without redrawing it`, async () => {
  const storage = memoryStorage(), a = await view({ storage }), b = await view({ storage });
  let journal = previewState(); a.show(journal); b.show(journal);
  if (editor === 'queued') {
    type(b, b.document.querySelector('#jc-attention [data-record="B1"] textarea'), 'Old comment');
    journal = commit(journal, { blockers: [{ ...journal.blockers[0], title: 'Changed connection' }] });
    a.show(journal); b.show(journal);
  }
  if (editor === 'other') {
    b.document.querySelector('#jc-attention [data-record="S1"][data-choice="other"]').click();
    await a.refresh(journal);
  }
  choice(a, 'A').click(); await b.refresh(journal);
  choice(a, 'B').click();
  const field = b.document.querySelector(editor === 'queued' ? '#jc-queued-comments textarea' : `#jc-attention [data-record="${editor === 'other' ? 'S1' : 'B1'}"] textarea`);
  type(b, field, 'My unrelated input');
  assert.equal(choice(b, 'B').getAttribute('aria-pressed'), 'true', 'any imported shared choice is visible before Send');
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.equal(b.envelope().items.find(item => item.id === 'D1').option_id, 'B');
});

for (const target of ['B1', 'R1', 'N1']) test(`a rejected stale comment clear restores visible shared text for ${target}`, async () => {
  const storage = memoryStorage(), a = await view({ storage }), b = await view({ storage });
  const journal = previewState(); a.show(journal); b.show(journal);
  const selector = target === 'R1' ? '#jc-tree [data-record="R1"] textarea' : `#jc-cards-body [data-record="${target}"] textarea`;
  type(a, a.document.querySelector(selector), 'Earlier comment'); await b.refresh(journal);
  type(a, a.document.querySelector(selector), 'Newer shared comment');
  type(b, b.document.querySelector(selector), '');
  assert.equal(b.document.querySelector(selector).value, 'Newer shared comment');
  await b.refresh(journal);
  assert.equal(b.document.querySelector(selector).value, 'Newer shared comment');
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.equal(b.envelope().items.find(item => item.id === target).text, b.document.querySelector(selector).value);
});

for (const editor of ['blocker', 'request', 'note', 'queued']) test(`accepted overlapping ${editor} comment edit must display the effective shared text before Send`, async () => {
  const storage = memoryStorage(), a = await view({ storage }), b = await view({ storage });
  let journal = previewState(); a.show(journal); b.show(journal);
  const target = editor === 'request' ? 'R1' : editor === 'note' ? 'N1' : 'B1';
  const ordinarySelector = editor === 'request' ? '#jc-tree [data-record="R1"] textarea' : `#jc-cards-body [data-record="${target}"] textarea`;
  const field = ui => ui.document.querySelector(editor === 'queued' ? '#jc-queued-comments textarea' : ordinarySelector);
  const activate = ui => ui.document.getElementById(editor === 'request' ? 'jc-requests-tab' : editor === 'queued' ? 'jc-attention-tab' : 'jc-cards-tab').click();
  activate(a); activate(b);
  type(a, a.document.querySelector(ordinarySelector), 'seed A');
  await b.refresh(journal); type(b, b.document.querySelector(ordinarySelector), 'seed B');
  const operations = [...storage.values.values()].map(JSON.parse);
  const aid = operations.find(operation => operation.draft?.text === 'seed A').id;
  const bid = operations.find(operation => operation.draft?.text === 'seed B').id;
  await a.refresh(journal); type(a, a.document.querySelector(ordinarySelector), '');
  await a.refresh(journal); await b.refresh(journal);
  const low = aid.localeCompare(bid) < 0 ? a : b, high = low === a ? b : a;
  if (editor === 'queued') {
    type(low, low.document.querySelector(ordinarySelector), 'Old queued comment'); await high.refresh(journal);
    journal = commit(journal, { blockers: [{ ...journal.blockers[0], title: 'Changed connection' }] });
    a.show(journal); b.show(journal);
  }
  const write = storage.setItem; let once = true;
  storage.setItem = (key, value) => {
    if (once && key.includes(':item:')) { once = false; type(high, field(high), 'Concurrent comment B'); }
    write(key, value);
  };
  const originalEditor = field(low);
  const originalRevision = JSON.parse(originalEditor.dataset.draftKey)[2];
  type(low, originalEditor, 'Visible comment A');
  assert.equal(field(low).value, 'Concurrent comment B', 'successful same-key merge must redraw its effective value');
  assert.equal(originalEditor.isConnected, false);
  type(low, originalEditor, 'Detached old input must not win');
  assert.equal(field(low).value, 'Concurrent comment B');
  await low.refresh(journal);
  assert.equal(field(low).value, 'Concurrent comment B', 'unchanged journal polling preserves the authoritative visible value');
  const visibleBeforeSend = field(low).value;
  low.document.getElementById('jc-send').click(); await tick();
  assert.equal(low.sent.length, 1);
  const sent = low.envelope().items.find(item => item.id === target);
  assert.equal(sent.text, visibleBeforeSend);
  assert.equal(sent.record_revision, originalRevision);
  assert.equal(field(low).value, visibleBeforeSend);
});
