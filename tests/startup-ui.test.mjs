import test from 'node:test';
import assert from 'node:assert/strict';
import { commit, state, tick, view } from './ui-harness.mjs';

const input = { conversation_id: 'C1' };
const incomplete = { content: [{ type: 'text', text: 'Journal C2, revision 1.' }] };
const readCall = { name: 'journal_read', arguments: { conversation_id: 'C1' } };
const result = journal => ({ content: [{ type: 'text', text: `Journal ${journal.conversation_id}, revision ${journal.revision}.` }],
  structuredContent: { journal, runtime_version: '0.6.3', tracking_enabled: true } });
const goal = ui => ui.document.getElementById('jc-goal-title').textContent;
const notice = ui => ui.document.getElementById('connection');

test('startup reads the saved journal when tool input and an incomplete result arrive during connection', async () => {
  const ui = await view({
    connectImpl(app) {
      app.ontoolinput?.({ arguments: input });
      app.ontoolresult(incomplete);
    },
    toolImpl: () => result(state()),
  });

  assert.equal(goal(ui), '원래 요청');
  assert.deepEqual(ui.toolCalls, [readCall]);
  assert.equal(notice(ui).hidden, true);
  assert.equal(ui.sent.length, 0);
});

test('startup recovers when valid tool input follows the incomplete result', async () => {
  const ui = await view({ toolImpl: () => result(state()) });
  ui.toolResult(incomplete);
  await ui.poll();
  assert.deepEqual(ui.toolCalls, []);

  ui.toolInput(input);
  await tick();
  assert.equal(goal(ui), '원래 요청');
  assert.deepEqual(ui.toolCalls, [readCall]);
});

test('a complete tool result renders without a startup read', async () => {
  const ui = await view();
  ui.toolInput(input);
  await ui.poll();
  ui.toolResult(result(state()));
  await tick();

  assert.equal(goal(ui), '원래 요청');
  assert.deepEqual(ui.toolCalls, []);
});

test('an invalid conversation argument and summary text cannot start a recovery read', async () => {
  const ui = await view();
  ui.toolInput({ conversation_id: '../C1' });
  ui.toolResult(incomplete);
  await ui.poll();

  assert.deepEqual(ui.toolCalls, []);
  assert.equal(goal(ui), '—');
  assert.match(notice(ui).textContent, /No journal data/);
});

test('an explicit failure from the display tool remains visible', async () => {
  const ui = await view();
  ui.toolInput(input);
  ui.toolResult({ isError: true, content: [{ type: 'text', text: 'Request Tracker is OFF for this conversation.' }] });
  await ui.poll();

  assert.deepEqual(ui.toolCalls, []);
  assert.equal(goal(ui), '—');
  assert.match(notice(ui).textContent, /OFF/);
});

test('a recovery read cannot display a different conversation and the next poll can recover', async () => {
  const journal = state();
  const ui = await view();
  ui.setRead({ ...journal, conversation_id: 'C2' });
  ui.toolInput(input);
  ui.toolResult(incomplete);
  await tick();

  assert.equal(goal(ui), '—');
  assert.match(notice(ui).textContent, /different conversation/i);
  assert.doesNotMatch(notice(ui).textContent, /showing the last saved version/i);
  await ui.refresh(journal);

  assert.equal(goal(ui), '원래 요청');
  assert.equal(notice(ui).hidden, true);
  assert.deepEqual(ui.toolCalls, [readCall, readCall]);
});

test('the poll shares an in-flight startup read and a stale response cannot replace a newer result', async () => {
  let finishRead;
  const pending = new Promise(resolve => { finishRead = resolve; });
  const old = state();
  const latest = commit(old, { requests: [{ ...old.requests[0], title: 'Updated goal' }] });
  const ui = await view({ toolImpl: () => pending });
  ui.toolInput(input);
  ui.toolResult(incomplete);
  const polled = ui.poll();
  ui.toolResult(result(latest));
  finishRead(result(old));
  await polled;
  await tick();

  assert.deepEqual(ui.toolCalls, [readCall]);
  assert.equal(goal(ui), 'Updated goal');
  assert.equal(notice(ui).hidden, true);
});

test('a foreign tool result cannot cancel an in-flight startup read', async () => {
  let finishRead;
  const pending = new Promise(resolve => { finishRead = resolve; });
  const journal = state();
  const ui = await view({ toolImpl: () => pending });
  ui.toolInput(input);
  ui.toolResult(incomplete);
  ui.toolResult(result({ ...journal, conversation_id: 'C2' }));

  assert.equal(goal(ui), '—');
  assert.match(notice(ui).textContent, /different conversation/i);
  finishRead(result(journal));
  await tick();

  assert.equal(goal(ui), '원래 요청');
  assert.deepEqual(ui.toolCalls, [readCall]);
  assert.equal(notice(ui).hidden, true);
});

test('an incomplete result cannot supersede an explicit display failure', async () => {
  const journal = state();
  const ui = await view({ toolImpl: () => result(journal) });
  ui.toolInput(input);
  ui.toolResult({ isError: true, content: [{ type: 'text', text: 'Request Tracker is OFF for this conversation.' }] });
  ui.toolResult(incomplete);
  await ui.poll();

  assert.equal(goal(ui), '—');
  assert.match(notice(ui).textContent, /OFF/);
  assert.deepEqual(ui.toolCalls, []);

  ui.toolResult(result(journal));
  assert.equal(goal(ui), '원래 요청');
  assert.equal(notice(ui).hidden, true);
});
