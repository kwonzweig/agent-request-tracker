import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, commit, previewState } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const request = (ui, id) => q(ui, '#jc-tree .jc-request[data-record="' + id + '"]');
const details = (ui, id) => request(ui, id).firstElementChild;
const card = (ui, id) => q(ui, '#jc-cards .jc-record[data-record="' + id + '"]');
function select(ui, id, value) {
  const control = q(ui, '#' + id);
  for (const option of control.children) option.toggleAttribute('selected', option.value === value);
  control.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}
function toggle(ui, node, open) {
  node.toggleAttribute('open', open); node.dispatchEvent(new ui.window.Event('toggle'));
}
function input(ui, node, value) {
  node.value = value; node.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
function nested() {
  const first = state();
  return commit(first, { requests: [
    { id: 'R2', parent_id: 'R1', title: 'Done parent', status: 'done', source: 'user:2' },
    { id: 'R3', parent_id: 'R2', title: 'Active grandchild', status: 'active', source: 'user:2' },
    { id: 'R4', parent_id: 'R1', title: 'Done leaf', status: 'done', source: 'user:2' },
    { id: 'R5', parent_id: 'R1', title: 'Cancelled leaf', status: 'cancelled', source: 'user:2' },
  ] });
}

test('four tabs preserve Request filters and make Cards a current inventory', async () => {
  const ui = await view(); ui.show(previewState());
  assert.deepEqual([...q(ui, '.jc-tabs').children].map(node => node.dataset.tab), ['attention', 'requests', 'cards', 'history']);
  assert.deepEqual([...q(ui, '.jc-filter').children].map(node => node.textContent), ['Active', 'Done', 'All']);
  assert.deepEqual([...q(ui, '#jc-request-view').children].map(node => node.textContent), ['Request tree', 'By workspace']);
  q(ui, '#jc-cards-tab').click();
  assert.deepEqual([...q(ui, '#jc-card-filter').children].map(node => node.textContent), ['All', 'Open', 'Closed', 'Later']);
  for (const id of ['D1', 'B1', 'S1', 'Q1', 'N1']) assert.equal(card(ui, id).hasAttribute('open'), false);
  assert.equal(card(ui, 'D1').querySelector('summary .jc-badge').textContent, 'Decision');
  assert.equal(card(ui, 'Q1').querySelector('summary .jc-record-title').textContent, '모바일 화면도 확인했나요?');
  assert.equal(card(ui, 'B1').querySelector('.jc-comment label').textContent, 'Comment');
  assert.equal(card(ui, 'B1').querySelector('textarea').closest('details'), card(ui, 'B1'));
  toggle(ui, card(ui, 'D1'), true);
  select(ui, 'jc-card-filter', 'closed');
  assert.deepEqual([...q(ui, '#jc-cards-body').querySelectorAll('.jc-record')].map(node => node.dataset.record).sort(), ['N1']);
  select(ui, 'jc-card-filter', 'open'); assert.equal(card(ui, 'D1').hasAttribute('open'), true);
});

test('request descendants live inside each parent disclosure while content has no nested Details', async () => {
  const ui = await view(); ui.show(nested()); q(ui, '#jc-requests-tab').click(); q(ui, '[data-filter="all"]').click();
  assert.equal(request(ui, 'R2').closest('details'), details(ui, 'R1'));
  assert.equal(request(ui, 'R3').closest('details'), details(ui, 'R2'));
  assert.equal(details(ui, 'R1').hasAttribute('open'), true);
  assert.equal(details(ui, 'R2').hasAttribute('open'), false);
  assert.equal(details(ui, 'R3').hasAttribute('open'), true);
  assert.equal(details(ui, 'R5').hasAttribute('open'), false);
  assert.equal(details(ui, 'R1').querySelector('.jc-request-body details'), null);
  assert.match(details(ui, 'R1').querySelector('.jc-request-body').textContent, /Done when|Comment|Background/);
  toggle(ui, details(ui, 'R1'), false);
  assert.equal(details(ui, 'R1').contains(request(ui, 'R3')), true);
  assert.equal(details(ui, 'R1').hasAttribute('open'), false);
});

test('filtered requests retain and expand ancestor context while manual folds survive edits and polling', async () => {
  const ui = await view(), first = nested(); ui.show(first); q(ui, '#jc-requests-tab').click();
  assert.deepEqual([...q(ui, '#jc-tree').querySelectorAll('.jc-request')].map(node => node.dataset.record), ['R1', 'R2', 'R3']);
  assert.equal(request(ui, 'R2').classList.contains('jc-context'), true);
  assert.equal(details(ui, 'R2').hasAttribute('open'), true);
  toggle(ui, details(ui, 'R2'), false); toggle(ui, details(ui, 'R1'), false);
  const changed = commit(first, { requests: [{ ...first.requests[0], title: 'Edited root', status: 'waiting' },
    { ...first.requests.find(record => record.id === 'R2'), title: 'Edited parent', status: 'cancelled' }] });
  await ui.refresh(changed);
  assert.equal(details(ui, 'R1').hasAttribute('open'), false);
  assert.equal(details(ui, 'R2').hasAttribute('open'), false);
  q(ui, '#jc-cards-tab').click(); q(ui, '#jc-requests-tab').click();
  q(ui, '[data-filter="done"]').click(); q(ui, '[data-filter="active"]').click();
  assert.equal(details(ui, 'R2').hasAttribute('open'), false);
  assert.match(request(ui, 'R1').textContent, /Edited root/);
});

test('workspace groups distinguish colliding labels by URL and retain unlinked requests and cross-group parent context', async () => {
  const ui = await view(), first = state();
  const journal = commit(first, { requests: [
    { ...first.requests[0], workspace: { id: '#1', url: 'https://github.com/team/alpha/pull/1' } },
    { id: 'R2', parent_id: 'R1', title: 'Other repo child', status: 'active', source: 'user:2', workspace: { id: '#1', url: 'https://github.com/team/beta/pull/1' } },
    { id: 'R3', parent_id: null, title: 'Unlinked request', status: 'active', source: 'user:2' },
    { id: 'R4', parent_id: null, title: 'Unsafe workspace', status: 'active', source: 'user:2', workspace: { id: 'Unsafe', url: 'javascript:alert(1)' } },
  ] });
  ui.show(journal); q(ui, '#jc-requests-tab').click(); select(ui, 'jc-request-view', 'workspace');
  const groups = [...q(ui, '#jc-tree').querySelectorAll('.jc-workspace-group')];
  assert.equal(groups.length, 4);
  const labels = groups.map(group => group.querySelector('h3').textContent);
  assert.ok(labels.some(label => label.includes('github.com/team/alpha/pull/1')));
  assert.ok(labels.some(label => label.includes('github.com/team/beta/pull/1')));
  const unlinked = groups.find(group => group.dataset.workspace === 'unlinked');
  assert.match(unlinked.textContent, /Unlinked request/);
  assert.equal(request(ui, 'R3').querySelector('.jc-workspace-link'), null);
  assert.equal(request(ui, 'R4').querySelector('.jc-workspace-link'), null);
  assert.equal(request(ui, 'R2').querySelector('[data-request-link="R1"]').textContent, '↗ Parent · 원래 요청');
  assert.equal(request(ui, 'R2').querySelector('.jc-workspace-link').getAttribute('href'), 'https://github.com/team/beta/pull/1');
});

test('workspace anchors use safe URLs and stop summary activation', async () => {
  const ui = await view(), journal = state(); journal.requests[0].workspace = { id: '#1', url: 'https://example.com/work/1' };
  ui.show(journal); q(ui, '#jc-requests-tab').click(); toggle(ui, details(ui, 'R1'), false);
  let summaryClicks = 0;
  details(ui, 'R1').firstElementChild.addEventListener('click', () => summaryClicks++);
  const link = request(ui, 'R1').querySelector('.jc-workspace-link'); link.click();
  assert.equal(link.textContent, '↗ #1'); assert.equal(link.getAttribute('href'), 'https://example.com/work/1');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(summaryClicks, 0); assert.equal(details(ui, 'R1').hasAttribute('open'), false);
});

test('Card request links reveal hidden done targets and folded ancestors, switch to tree and highlight the request', async () => {
  const ui = await view(), first = nested();
  const journal = commit(first, { requests: [{ ...first.requests.find(record => record.id === 'R3'), status: 'done' }],
    decisions: [{ ...first.decisions[0], request_id: 'R3' }] });
  ui.show(journal); q(ui, '#jc-requests-tab').click(); toggle(ui, details(ui, 'R1'), false);
  select(ui, 'jc-request-view', 'workspace'); q(ui, '#jc-cards-tab').click();
  card(ui, 'D1').querySelector('[data-request-link="R3"]').click();
  assert.equal(q(ui, '#jc-requests-tab').getAttribute('aria-selected'), 'true');
  assert.equal(q(ui, '#jc-request-view').value, 'tree');
  assert.equal(q(ui, '[data-filter="all"]').getAttribute('aria-pressed'), 'true');
  for (const id of ['R1', 'R2', 'R3']) assert.equal(details(ui, id).hasAttribute('open'), true);
  assert.equal(request(ui, 'R3').classList.contains('jc-revealed'), true);
  q(ui, '[data-filter="done"]').click(); q(ui, '#jc-attention-tab').click();
  // R1 is already visible as ancestor context in Done; reveal must retain that filter.
  q(ui, '#jc-attention [data-request-link="R3"]').click();
  assert.equal(q(ui, '[data-filter="done"]').getAttribute('aria-pressed'), 'true');
});

test('choice Other and comment drafts stay shared across Attention and Cards, filtering, folding and polling', async () => {
  const ui = await view(), first = previewState(); ui.show(first); q(ui, '#jc-cards-tab').click();
  card(ui, 'D1').querySelector('[data-choice="other"]').click();
  input(ui, card(ui, 'D1').querySelector('textarea'), 'Keep my custom answer');
  input(ui, card(ui, 'B1').querySelector('textarea'), 'Keep my comment');
  toggle(ui, card(ui, 'D1'), false); toggle(ui, card(ui, 'B1'), false);
  select(ui, 'jc-card-filter', 'closed'); select(ui, 'jc-card-filter', 'all');
  assert.equal(card(ui, 'D1').hasAttribute('open'), false);
  assert.equal(card(ui, 'D1').querySelector('textarea').value, 'Keep my custom answer');
  assert.ok(card(ui, 'D1').querySelector('summary .jc-draft-hint') === null);
  q(ui, '#jc-attention-tab').click();
  assert.equal(q(ui, '#jc-attention [data-record="D1"] textarea').value, 'Keep my custom answer');
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').value, 'Keep my comment');
  q(ui, '#jc-attention [data-choice="A"]').click(); q(ui, '#jc-attention [data-choice="other"]').click();
  assert.equal(q(ui, '#jc-attention [data-record="D1"] textarea').value, 'Keep my custom answer');
  await ui.refresh(commit(first, { turn: { summary: 'Unchanged records' } })); q(ui, '#jc-cards-tab').click();
  assert.equal(card(ui, 'B1').hasAttribute('open'), false);
  assert.equal(card(ui, 'B1').querySelector('textarea').value, 'Keep my comment');
  assert.match(q(ui, '#jc-draft').textContent, /2 replies ready/);
});

test('unacknowledged agent-owned blockers remain Attention without implying Needs your input', async () => {
  const ui = await view(), first = state();
  const journal = commit(first, { decisions: [{ ...first.decisions[0], status: 'answered' }],
    blockers: [{ id: 'B1', request_id: 'R1', title: 'Agent dependency', owner: 'agent', status: 'open', evidence: 'Agent waits', next_action: 'Retry tool' }] });
  ui.show(journal);
  assert.ok(q(ui, '#jc-attention [data-record="B1"]'));
  assert.equal(q(ui, '#jc-count').textContent, '1');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Unknown');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Blocked');
  assert.equal(card(ui, 'B1').hasAttribute('open'), false);
});
