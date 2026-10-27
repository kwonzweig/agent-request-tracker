import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { evaluateStop, readJournal, updateJournal } from '../src/store.mjs';
import { evaluateStopAssessment } from '../src/completion.mjs';
import { view } from './ui-harness.mjs';
import { legacyDoneFixture } from './legacy-done-fixture.mjs';

const request = { id: 'R1', title: 'Prepare the authorized report', done_when: 'The source-backed report is verified',
  source: 'user:1', status: 'active' };
const blocker = { id: 'B1', request_id: 'R1', title: 'Source access is unavailable', evidence: 'tool:source-denied',
  next_action: 'Restore source access', owner: 'user', status: 'open' };
const update = (expected_revision, upsert, end_reason = null) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Check the current outcome', end_reason }, upsert });

async function temporaryJournal(t) {
  const runtime = resolve('.runtime');
  await mkdir(runtime, { recursive: true });
  const dir = await mkdtemp(join(runtime, 'completion-'));
  t.after(async () => {
    assert.equal(dirname(dir), runtime, 'cleanup stays inside the isolated test runtime');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function setup(t, later = false) {
  const dir = await temporaryJournal(t);
  await updateJournal(dir, 'completion', update(0, { requests: [request], blockers: [{ ...blocker,
    ...(later ? { attention: { state: 'later', actor: 'user', source: 'user:later-source-access' } } : {}) }] }));
  return dir;
}

const finish = (dir, end_reason = 'complete') => legacyDoneFixture(dir, 'completion', update(1, {
  requests: [{ id: 'R1', status: 'done', evidence: 'artifact:report-verified' }],
}, end_reason));

async function stopHook(dir, turnId) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['src/hook.mjs'], {
      env: { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(stderr || `Hook exited ${code}`)); return; }
      try { resolveResult(stdout ? JSON.parse(stdout) : null); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ session_id: 'completion', turn_id: turnId, hook_event_name: 'Stop' }));
  });
}

for (const end_reason of ['complete', 'answer_delivered']) {
  for (const later of [false, true]) {
    test(`${end_reason}: an ${later ? 'open Later' : 'open'} blocker prevents completion of its legacy Done request`, async t => {
      const dir = await setup(t, later);
      await finish(dir, end_reason);
      const saved = await readJournal(dir, 'completion');
      assert.equal(saved.requests[0].status, 'done');
      assert.equal(saved.blockers[0].status, 'open');
      const gate = evaluateStop(saved, { turnId: 'T2' });
      assert.equal(gate.allowed, false);
      assert.match(gate.reason, /unresolved blockers: B1/);
      const ui = await view();
      ui.show(saved);
      assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'Blocked');
      assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Work remains');
    });
  }
}

for (const status of ['deferred', 'cancelled', 'proposed']) {
  for (const currentStatus of ['active', 'done']) {
    test(`Goal includes the ${status} root while its open inputs do not block Agent's unrelated ${currentStatus} work`, async t => {
      const dir = await setup(t);
      const saved = await updateJournal(dir, 'completion', update(1, {
        requests: [{ id: 'R1', status, source: 'user:exclude-current-scope' },
          { ...request, id: 'R2', title: 'Prepare the independent summary', status: currentStatus,
            ...(currentStatus === 'done' ? { evidence: 'artifact:summary-verified' } : {}) }],
        decisions: [{ id: 'D1', request_id: 'R1', revision: 1, question: 'Which source should the excluded request use?',
          why: 'The excluded work needs its own choice', no_answer_behavior: 'Wait for the choice', required: true, status: 'open',
          options: [{ id: 'A', label: 'Use this source', impact: 'Uses the selected source for the excluded request' }] }],
      }, currentStatus === 'done' ? 'complete' : null));
      assert.equal(saved.blockers[0].status, 'open');
      assert.equal(evaluateStop(saved, { turnId: 'T2' }).allowed, currentStatus === 'done');
      const ui = await view();
      ui.show(saved);
      // Goal covers every displayed root; Agent completion covers current authorized work.
      const goalStatus = currentStatus === 'active' ? 'In progress' :
        { deferred: 'Deferred', cancelled: 'Done', proposed: 'Proposed' }[status];
      assert.equal(ui.document.querySelector('#jc-goal-status').textContent, goalStatus);
      assert.equal(ui.document.querySelector('#jc-agent-status').textContent, currentStatus === 'done' ? 'Done' : 'Unknown');
    });
  }
}

test('an open blocker on active authorized work keeps Goal Blocked and Agent Needs your input', async t => {
  const dir = await setup(t), saved = await readJournal(dir, 'completion');
  const ui = await view();
  ui.show(saved);
  assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'Blocked');
  assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Needs your input');
});

for (const status of ['resolved', 'dismissed']) {
  test(`writer-validated ${status} blocker permits completion and retains its provenance`, async t => {
    const dir = await setup(t, true);
    const unfinished = await finish(dir);
    assert.equal(evaluateStop(unfinished, { turnId: 'T2' }).allowed, false);
    const provenance = status === 'resolved'
      ? { resolution: { actor: 'agent', source: 'tool:source-operation-succeeded', note: 'The affected source operation succeeded', record_revision: 1 } }
      : { dismissal: { actor: 'user', source: 'user:use-supplied-export', reason: 'The supplied export replaces the inaccessible source' } };
    const closed = await updateJournal(dir, 'completion', update(2, { blockers: [{ id: 'B1', status, ...provenance }] }, 'complete'));
    assert.equal(evaluateStop(closed, { turnId: 'T3' }).allowed, true);
    assert.deepEqual(closed.blockers[0][status === 'resolved' ? 'resolution' : 'dismissal'],
      provenance[status === 'resolved' ? 'resolution' : 'dismissal']);
    assert.equal(closed.history[0].changes.find(change => change.collection === 'blockers').after.status, 'open');
    const ui = await view();
    ui.show(closed);
    assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'Done');
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Done');
  });
}

test('the saved Later blocker produces matching UI and Stop-hook completion checks', async t => {
  const dir = await setup(t, true), saved = await finish(dir);
  const ui = await view();
  ui.show(saved);
  assert.equal(ui.document.querySelector('#jc-attention [data-record="B1"]'), null);
  assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'Blocked');
  assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Work remains');
  const gate = evaluateStop(saved, { turnId: 'T2' }), blocked = await stopHook(dir, 'T2');
  assert.equal(gate.allowed, false);
  assert.equal(blocked.decision, 'block');
  assert.ok(blocked.reason.includes(gate.reason));

  const verified = await updateJournal(dir, 'completion', update(2, { blockers: [{ id: 'B1', status: 'resolved',
    resolution: { actor: 'agent', source: 'tool:source-operation-succeeded', note: 'The affected source operation succeeded', record_revision: 1 } }] }, 'complete'));
  await ui.refresh(verified);
  assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'Done');
  assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Done');
  assert.equal(evaluateStop(verified, { turnId: 'T3' }).allowed, true);
  assert.deepEqual(await stopHook(dir, 'T3'), {});
});

const running = request_ids => ({ id: 'observed-run', status: 'running', evidence: 'runner:current-observation',
  observed_turn_id: 'T1', request_ids });

for (const end_reason of ['complete', 'answer_delivered']) {
  test(`${end_reason}: a fresh run for canceled work cannot replace completion with Working`, async t => {
    const dir = await temporaryJournal(t), checkpoint = update(0, { requests: [
      { ...request, status: 'done', evidence: 'artifact:report-verified' },
      { ...request, id: 'R2', status: 'cancelled', source: 'user:cancel-old-work' },
    ] }, end_reason);
    checkpoint.turn.continuing_run = running(['R2']);
    const saved = await updateJournal(dir, 'completion', checkpoint);
    assert.equal(evaluateStop(saved, { turnId: 'T1' }).allowed, true);
    const ui = await view();
    ui.show(saved);
    assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'Done');
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Done');
  });

  test(`${end_reason}: a current active run cannot replace the shared unfinished-work check`, async t => {
    const dir = await temporaryJournal(t), checkpoint = update(0, { requests: [request] }, end_reason);
    checkpoint.turn.continuing_run = running(['R1']);
    const saved = await updateJournal(dir, 'completion', checkpoint), gate = evaluateStop(saved, { turnId: 'T1' });
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /requests unfinished: R1/);
    const ui = await view();
    ui.show(saved);
    assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'In progress');
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Work remains');
  });
}

for (const status of ['cancelled', 'deferred', 'proposed', 'done']) {
  test(`a fresh background run on only ${status} work does not claim Working for active work`, async t => {
    const dir = await temporaryJournal(t), checkpoint = update(0, { requests: [request,
      { ...request, id: 'R2', status, ...(status === 'done' ? { evidence: 'artifact:earlier-report-verified' } : {}) },
    ] }, 'background');
    checkpoint.turn.continuing_run = running(['R2']);
    const saved = await updateJournal(dir, 'completion', checkpoint);
    assert.equal(evaluateStop(saved, { turnId: 'T1' }).allowed, false);
    const ui = await view();
    ui.show(saved);
    assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'In progress');
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Work remains');
  });
}

for (const status of ['active', 'waiting']) {
  test(`a current evidenced run covering ${status} work honestly displays Working`, async t => {
    const dir = await temporaryJournal(t), checkpoint = update(0, { requests: [{ ...request, status }] }, 'background');
    checkpoint.turn.continuing_run = running(['R1']);
    const saved = await updateJournal(dir, 'completion', checkpoint);
    assert.equal(evaluateStop(saved, { turnId: 'T1' }).allowed, true);
    const ui = await view();
    ui.show(saved);
    assert.equal(ui.document.querySelector('#jc-goal-status').textContent, status === 'active' ? 'In progress' : 'Waiting');
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Working');
  });
}

test('an explicit interrupted checkpoint takes precedence over a current run observation', async t => {
  const dir = await temporaryJournal(t), checkpoint = update(0, { requests: [request] }, 'interrupted');
  checkpoint.turn.continuing_run = running(['R1']);
  const saved = await updateJournal(dir, 'completion', checkpoint);
  assert.equal(evaluateStop(saved, { turnId: 'T1' }).allowed, false);
  const ui = await view();
  ui.show(saved);
  assert.equal(ui.document.querySelector('#jc-goal-status').textContent, 'In progress');
  assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Interrupted');
});

for (const requiredness of ['omitted', null, false]) {
  for (const lifecycle of ['open', 'later', 'dismissed', 'superseded']) {
    test(`${requiredness}: ${lifecycle} unanswered choice cannot silently complete authorized work`, async t => {
      const dir = await temporaryJournal(t);
      const decision = { id: 'D1', request_id: 'R1', revision: 1, question: 'May the report be published?',
        why: 'Publication needs permission', no_answer_behavior: 'Wait for permission', status: 'open',
        options: [{ id: 'A', label: 'Publish', impact: 'Makes the report public' }] };
      if (requiredness !== 'omitted') decision.required = requiredness;
      await updateJournal(dir, 'completion', update(0, { requests: [request], decisions: [decision] }));
      const patch = lifecycle === 'later' ? { attention: { state: 'later', actor: 'user', source: 'user:later' } }
        : lifecycle === 'open' ? {} : { status: lifecycle, ...(lifecycle === 'dismissed' ? {
          dismissal: { actor: 'agent', source: 'agent:retire', reason: 'Retire the visible question' } } : {}) };
      const save = requiredness === false ? updateJournal : legacyDoneFixture;
      const saved = await save(dir, 'completion', update(1, {
        requests: [{ id: 'R1', status: 'done', evidence: 'artifact:verified-report' }],
        decisions: [{ id: 'D1', ...patch }],
      }, 'complete'));
      const gate = evaluateStop(saved, { turnId: 'T2' });
      assert.equal(gate.allowed, requiredness === false);
      if (requiredness !== false) assert.match(gate.reason, /required choices: D1/);
    });
  }
}

for (const requiredness of ['omitted', null]) {
  for (const status of ['cancelled', 'deferred', 'proposed']) {
    test(`${requiredness} requiredness on ${status} scope does not block independent completion`, async t => {
      const dir = await temporaryJournal(t);
      const saved = await updateJournal(dir, 'completion', update(0, {
        requests: [{ ...request, status }, { ...request, id: 'R2', status: 'done', evidence: 'artifact:done' }],
        decisions: [{ id: 'D1', request_id: 'R1', revision: 1, question: 'May excluded work run?', why: 'Permission',
          no_answer_behavior: 'Wait', status: 'open', ...(requiredness === null ? { required: null } : {}),
          options: [{ id: 'A', label: 'Run', impact: 'Runs excluded work' }] }],
      }, 'complete'));
      assert.equal(evaluateStop(saved, { turnId: 'T1' }).allowed, true);
    });
  }
}

for (const end_reason of ['decision', 'blocker', 'background']) {
  test(`${end_reason}: a boundary for one request cannot justify handback of independent work`, async t => {
    const dir = await temporaryJournal(t), checkpoint = update(0, { requests: [request, { ...request, id: 'R2' }],
      ...(end_reason === 'decision' ? { decisions: [{ id: 'D1', request_id: 'R1', revision: 1,
        question: 'Choose report format', why: 'Format needed', no_answer_behavior: 'Wait', required: true, status: 'open',
        options: [{ id: 'A', label: 'Text', impact: 'Writes text' }] }] } : {}),
      ...(end_reason === 'blocker' ? { blockers: [blocker] } : {}),
    }, end_reason);
    if (end_reason === 'background') checkpoint.turn.continuing_run = running(['R1']);
    const saved = await updateJournal(dir, 'completion', checkpoint);
    const assessment = evaluateStopAssessment(saved, { turnId: 'T1' });
    assert.deepEqual(assessment, evaluateStop(saved, { turnId: 'T1' }));
    assert.equal(assessment.allowed, false);
    assert.match(assessment.reason, /lack an applicable boundary: R2/);
    const ui = await view();
    ui.show(saved);
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent, 'Work remains');
  });
}

for (const end_reason of ['decision', 'background']) {
  test(`${end_reason}: covering every independent request supports the normal Agent label`, async t => {
    const dir = await temporaryJournal(t);
    const requests = [request, { ...request, id: 'R2' }];
    const checkpoint = update(0, { requests,
      ...(end_reason === 'decision' ? { decisions: requests.map(item => ({ id: `D${item.id.slice(1)}`,
        request_id: item.id, revision: 1, question: 'Which report format?', why: 'Format needed',
        no_answer_behavior: 'Wait for format', required: true, status: 'open',
        options: [{ id: 'A', label: 'Text', impact: 'Writes text' }] })) } : {}),
    }, end_reason);
    if (end_reason === 'background') checkpoint.turn.continuing_run = running(['R1', 'R2']);
    const saved = await updateJournal(dir, 'completion', checkpoint);
    assert.equal(evaluateStopAssessment(saved, { turnId: 'T1' }).allowed, true);
    const ui = await view();
    ui.show(saved);
    assert.equal(ui.document.querySelector('#jc-agent-status').textContent,
      end_reason === 'decision' ? 'Needs your input' : 'Working');
  });
}
