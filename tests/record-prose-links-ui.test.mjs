import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { view, state, commit } from './ui-harness.mjs';
import { readJournal, updateJournal } from '../src/store.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const destinations = ['https://example.test/approved', 'https://example.test/restricted'];
const prose = `Use ${destinations[0]}; never use ${destinations[1]}.`;
const visibleProse = 'Use example.test/approved; never use example.test/restricted.';
const note = body => ({ id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: 'Allowed destination',
  body, status: 'open', source: 'assistant:2' });
const hrefs = node => [...node.querySelectorAll('a')].map(link => link.getAttribute('href'));
async function written(t, updates) {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-record-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = await updateJournal(dir, 'C1', { expected_revision: 0,
    turn: { id: 'T1', source: 'user:1', summary: 'Record fictional link conditions', end_reason: null },
    upsert: { requests: [{ id: 'R1', title: 'Verify approved destinations', done_when: 'Verified output',
      status: 'active', source: 'user:1' }], ...updates } });
  return { dir, journal };
}

test('writer-created adjacent Markdown links agree inline and in resource rows across card views', async t => {
  const urls = ['https://example.test/a', 'https://example.test/b'];
  const { dir, journal } = await written(t, { cards: [note('Use [A](https://example.test/a)[B](https://example.test/b).')] });
  const ui = await view(); ui.show(journal);
  for (const selector of ['#jc-attention [data-record="N1"]', '#jc-cards-body [data-record="N1"]', '#jc-history-cards [data-record="N1"]']) {
    const record = q(ui, selector), primary = record.querySelector('.jc-primary');
    assert.equal(primary.textContent, 'Use AB.');
    assert.deepEqual(hrefs(primary), urls);
    assert.deepEqual([...record.querySelectorAll('.jc-resource-link')].map(link => link.getAttribute('href')), urls);
  }
  assert.deepEqual(await readJournal(dir, 'C1'), journal);
  assert.equal(ui.sent.length, 0);
});

test('writer-created Done Request URL-only Evidence arrays stay in the resource row', async t => {
  const urls = ['https://example.test/check?run=19#ok', 'https://example.test/check?run=20#ok'];
  const { dir, journal } = await written(t, { requests: [{ id: 'R1', title: 'Verify approved destinations',
    done_when: 'Verified output', status: 'done', source: 'user:1', evidence: urls }] });
  const ui = await view(); ui.show(journal); q(ui, '[data-filter="done"]').click();
  for (const selector of ['#jc-tree [data-record="R1"]', '#jc-history-requests [data-record="R1"]']) {
    const request = q(ui, selector);
    assert.equal([...request.querySelectorAll('.jc-detail-field strong')].some(label => label.textContent === 'Evidence'), false);
    assert.deepEqual([...request.querySelectorAll('.jc-resource-link')].map(link => link.getAttribute('href')), urls);
  }
  const changed = await updateJournal(dir, 'C1', { expected_revision: journal.revision,
    turn: { id: 'T2', source: 'user:2', summary: 'Retain substantive evidence', end_reason: null },
    upsert: { requests: [{ id: 'R1', evidence: [prose] }] } });
  await ui.refresh(changed);
  const field = q(ui, '#jc-tree [data-record="R1"] .jc-detail-field');
  assert.equal(field.querySelector('strong').textContent, 'Evidence');
  assert.ok(field.querySelector('p').textContent.includes(visibleProse));
  assert.deepEqual(hrefs(field), destinations);
  assert.deepEqual(await readJournal(dir, 'C1'), changed);
  assert.equal(ui.sent.length, 0);
});

test('prose distinguishes an HTTP destination from HTTPS at the same address', async () => {
  const ui = await view();
  ui.show(commit(state(), { cards: [note('Use https://example.test/policy; never use http://example.test/policy.')] }));
  const body = q(ui, '#jc-attention [data-record="N1"] .jc-primary');
  assert.equal(body.textContent, 'Use example.test/policy; never use http://example.test/policy.');
  assert.deepEqual(hrefs(body), ['https://example.test/policy', 'http://example.test/policy']);
});

test('record prose retains destination-specific conditions across Attention, Cards, Requests and History', async () => {
  const ui = await view(), first = state();
  const journal = commit(first, { requests: [{ ...first.requests[0], done_when: prose }], cards: [note(prose)] });
  const before = structuredClone(journal);
  ui.show(journal);
  for (const selector of ['#jc-attention [data-record="N1"]', '#jc-cards-body [data-record="N1"]', '#jc-history-cards [data-record="N1"]']) {
    const record = q(ui, selector), primary = record.querySelector('.jc-primary');
    assert.equal(primary.textContent, visibleProse);
    assert.deepEqual(hrefs(primary), destinations);
    assert.deepEqual([...record.querySelectorAll('.jc-resource-link')].map(link => link.textContent),
      ['↗ example.test/approved', '↗ example.test/restricted']);
    for (const link of primary.querySelectorAll('a')) {
      assert.equal(link.getAttribute('target'), '_blank');
      assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    }
  }
  for (const selector of ['#jc-tree [data-record="R1"]', '#jc-history-requests [data-record="R1"]']) {
    const condition = q(ui, selector).querySelector('.jc-done-when li');
    assert.equal(condition.textContent, visibleProse);
    assert.deepEqual(hrefs(condition), destinations);
  }
  assert.deepEqual(journal, before);
  assert.equal(ui.sent.length, 0);
});

test('inline destinations and colliding link-row labels retain query and fragment distinctions', async () => {
  const ui = await view();
  const urls = ['https://example.test/policy?mode=approved#scope', 'https://example.test/policy?mode=restricted#scope'];
  ui.show(commit(state(), { cards: [note(`Use ${urls[0]}; never use ${urls[1]}.`)] }));
  const record = q(ui, '#jc-attention [data-record="N1"]'), primary = record.querySelector('.jc-primary');
  assert.equal(primary.textContent, 'Use example.test/policy?mode=approved#scope; never use example.test/policy?mode=restricted#scope.');
  assert.deepEqual(hrefs(primary), urls);
  assert.deepEqual([...record.querySelectorAll('.jc-resource-link')].map(link => link.textContent),
    ['↗ example.test/policy?mode=approved#scope', '↗ example.test/policy?mode=restricted#scope']);
});

test('standalone URL-only evidence stays in the link row while evidence sentences retain their meaning', async () => {
  const ui = await view(), first = state(), evidence = 'https://example.test/check?run=27#result';
  ui.show(commit(first, { requests: [{ ...first.requests[0], evidence }],
    blockers: [{ id: 'B1', request_id: 'R1', title: 'Inspect the check', evidence, next_action: 'Inspect the result', status: 'open', owner: 'user' }] }));
  const request = q(ui, '#jc-tree [data-record="R1"]');
  assert.equal(request.querySelector('.jc-detail-field strong').textContent, 'Background');
  assert.deepEqual(hrefs(request.querySelector('.jc-record-refs')), [evidence]);
  const blocker = q(ui, '#jc-attention [data-record="B1"]');
  assert.equal(blocker.querySelector('.jc-primary'), null);
  assert.deepEqual(hrefs(blocker.querySelector('.jc-record-refs')), [evidence]);
  assert.doesNotMatch(request.textContent + blocker.textContent, /https?:\/\//);
  const changed = commit(first, { requests: [{ ...first.requests[0], evidence: prose }] });
  await ui.refresh(changed);
  const field = q(ui, '#jc-tree [data-record="R1"] .jc-detail-field');
  assert.equal(field.querySelector('strong').textContent, 'Evidence');
  assert.equal(field.querySelector('p').textContent, visibleProse);
  assert.deepEqual(hrefs(field), destinations);
});

test('record Markdown links preserve explicit destinations and unsafe markup remains inert', async () => {
  const ui = await view();
  const value = '(See [approved](https://example.test/approved?mode=why?#part;)). Never [restricted](https://example.test/restricted). <img src=x onerror=bad()> [bad](javascript:alert(1))';
  ui.show(commit(state(), { cards: [note(value)] }));
  const primary = q(ui, '#jc-attention [data-record="N1"] .jc-primary');
  assert.match(primary.textContent, /\(See approved\)\. Never restricted\./);
  assert.deepEqual(hrefs(primary), ['https://example.test/approved?mode=why?#part;', destinations[1]]);
  assert.equal(primary.querySelector('img'), null);
  assert.match(primary.textContent, /\[bad\]\(javascript:alert\(1\)\)/);
});
