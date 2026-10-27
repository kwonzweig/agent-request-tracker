import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceGroups } from '../src/journal-views.mjs';
import { view, state, commit } from './ui-harness.mjs';

const rootWorkspace = { id: 'Ticket #27', url: 'HTTPS://EXAMPLE.COM:443/tickets/27?view=work#details' };
const childWorkspace = { id: 'PR #9', url: 'https://example.com/pull/9' };
const groupSummary = requests => workspaceGroups(requests).map(group => ({
  key: group.key, label: group.label, url: group.url, requests: group.requests.map(request => request.id),
}));

test('workspace groups inherit an omitted workspace through the request ancestry', () => {
  const requests = [
    { id: 'child', parent_id: 'root' },
    { id: 'grandchild', parent_id: 'child' },
    { id: 'root', workspace: rootWorkspace },
  ];
  const before = structuredClone(requests);
  assert.deepEqual(groupSummary(requests), [{
    key: 'https://example.com/tickets/27?view=work#details', label: 'Ticket #27',
    url: 'https://example.com/tickets/27?view=work#details', requests: ['child', 'grandchild', 'root'],
  }]);
  assert.deepEqual(requests, before);
});

test('an explicit null workspace stops inheritance for a request and its descendants', () => {
  const requests = [
    { id: 'root', workspace: rootWorkspace },
    { id: 'cleared', parent_id: 'root', workspace: null },
    { id: 'cleared-child', parent_id: 'cleared' },
  ];
  assert.deepEqual(groupSummary(requests), [
    { key: 'https://example.com/tickets/27?view=work#details', label: 'Ticket #27',
      url: 'https://example.com/tickets/27?view=work#details', requests: ['root'] },
    { key: 'unlinked', label: 'Unlinked', url: null, requests: ['cleared', 'cleared-child'] },
  ]);
});

test('a child workspace overrides its ancestor and becomes the nearest inherited workspace', () => {
  const requests = [
    { id: 'root', workspace: rootWorkspace },
    { id: 'override', parent_id: 'root', workspace: childWorkspace },
    { id: 'override-child', parent_id: 'override' },
  ];
  assert.deepEqual(groupSummary(requests), [
    { key: 'https://example.com/tickets/27?view=work#details', label: 'Ticket #27',
      url: 'https://example.com/tickets/27?view=work#details', requests: ['root'] },
    { key: 'https://example.com/pull/9', label: 'PR #9', url: 'https://example.com/pull/9',
      requests: ['override', 'override-child'] },
  ]);
});

test('workspace groups safely resolve cycles and missing parents', () => {
  const requests = [
    { id: 'cycle-a', parent_id: 'cycle-b' },
    { id: 'cycle-b', parent_id: 'cycle-a' },
    { id: 'orphan', parent_id: 'missing' },
    { id: 'linked-cycle-child', parent_id: 'linked-cycle-root' },
    { id: 'linked-cycle-root', parent_id: 'linked-cycle-child', workspace: childWorkspace },
  ];
  assert.deepEqual(groupSummary(requests), [
    { key: 'unlinked', label: 'Unlinked', url: null, requests: ['cycle-a', 'cycle-b', 'orphan'] },
    { key: 'https://example.com/pull/9', label: 'PR #9', url: 'https://example.com/pull/9',
      requests: ['linked-cycle-child', 'linked-cycle-root'] },
  ]);
});

async function workspaceView(requests) {
  const ui = await view();
  ui.show(commit(state(), { requests }));
  ui.document.getElementById('jc-requests-tab').click();
  const control = ui.document.getElementById('jc-request-view');
  for (const option of control.children) option.toggleAttribute('selected', option.value === 'workspace');
  control.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  return ui;
}
const activeRequest = (id, parent_id, extras = {}) => ({ id, parent_id, title: `Request ${id}`,
  status: 'active', source: 'user:1', done_when: 'Verify the result.', ...extras });
const requestRow = (ui, id) => ui.document.querySelector(`#jc-tree .jc-request[data-record="${id}"]`);

test('an explicitly unlinked grandchild retains Parent navigation to its inherited linked parent', async () => {
  const ui = await workspaceView([
    activeRequest('R1', null, { workspace: rootWorkspace }),
    activeRequest('R2', 'R1'),
    activeRequest('R3', 'R2', { workspace: null }),
  ]);
  assert.equal(requestRow(ui, 'R2').closest('.jc-workspace-group').dataset.workspace,
    'https://example.com/tickets/27?view=work#details');
  const grandchild = requestRow(ui, 'R3');
  assert.equal(grandchild.closest('.jc-workspace-group').dataset.workspace, 'unlinked');
  const parent = grandchild.querySelector('[data-request-link="R2"]');
  assert.ok(parent, 'the parent is in another effective workspace group');
  assert.equal(parent.textContent, '↗ Parent · Request R2');
  parent.click();
  assert.equal(ui.document.getElementById('jc-request-view').value, 'tree');
  assert.equal(requestRow(ui, 'R2').classList.contains('jc-revealed'), true);
});

test('Parent references compare effective destinations across inheritance, overrides and null boundaries', async () => {
  const ui = await workspaceView([
    activeRequest('R1', null, { workspace: rootWorkspace }),
    activeRequest('R2', 'R1'),
    activeRequest('R3', 'R2', { workspace: { id: 'Same ticket', url: 'https://example.com/tickets/27?view=work#details' } }),
    activeRequest('R4', 'R2', { workspace: childWorkspace }),
    activeRequest('R5', 'R4'),
    activeRequest('R6', 'R4', { workspace: null }),
    activeRequest('R7', 'R6'),
  ]);
  for (const [id, parentId, expected] of [
    ['R2', 'R1', false], ['R3', 'R2', false], ['R4', 'R2', true],
    ['R5', 'R4', false], ['R6', 'R4', true], ['R7', 'R6', false],
  ]) {
    const parent = requestRow(ui, id).querySelector(`[data-request-link="${parentId}"]`);
    assert.equal(parent != null, expected, `Parent navigation for ${id}`);
  }
});
