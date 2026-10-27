import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState } from './ui-harness.mjs';

test('closed cards with an older Later flag appear only in Closed, never Later', async () => {
  const ui = await view(), journal = previewState();
  journal.blockers[0].status = 'resolved';
  journal.blockers[0].attention = { state: 'later', actor: 'user', source: 'example:earlier-reply' };
  ui.show(journal);
  const select = value => {
    const control = ui.document.querySelector('#jc-card-filter');
    for (const option of control.children) option.toggleAttribute('selected', option.value === value);
    control.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  };
  const blocker = () => ui.document.querySelector('#jc-cards-body [data-record="B1"]');
  select('deferred');
  assert.equal(Boolean(blocker()), false);
  select('closed');
  assert.equal(blocker().querySelector('.jc-card-status').textContent, '✓ Resolved');
  select('open');
  assert.equal(Boolean(blocker()), false);
});
