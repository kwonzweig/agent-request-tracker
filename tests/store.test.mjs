import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evaluateStop, readJournal, updateJournal, validateJournal } from '../src/store.mjs';

const runFile = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function inTemp(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'request-journal-test-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const request = (id = 'R1', extras = {}) => ({
  id, parent_id: null, title: 'Deliver the requested feature',
  done_when: 'The feature works and is verified', status: 'active',
  source: 'user:1', ...extras,
});
const turn = (id, end_reason = null, extras = {}) => ({
  id, source: 'user:1', summary: 'Recorded current work', end_reason, ...extras,
});
const update = (revision, id, upsert = {}, end_reason = null, extras = {}) => ({
  expected_revision: revision, turn: turn(id, end_reason, extras), upsert,
});
const decision = (extras = {}) => ({
  id: 'D1', request_id: 'R1', revision: 1, question: 'Which option?', why: 'A choice is required',
  options: [{ id: 'A', label: 'A', impact: 'First effect' }, { id: 'B', label: 'B', impact: 'Second effect' }],
  recommendation: 'A', no_answer_behavior: 'Wait for a response', status: 'open', ...extras,
});
const blocker = () => ({
  id: 'B1', request_id: 'R1', title: 'Missing access', evidence: 'tool:error:login-required',
  next_action: 'Sign in', owner: 'user', status: 'open',
});

test('persists a journal across reads and retains omitted unresolved records', async () => inTemp(async dir => {
  const first = await updateJournal(dir, 'conversation-1', update(0, 'T1', {
    requests: [request()], decisions: [decision()], blockers: [blocker()],
  }));
  assert.equal(first.revision, 1);
  assert.equal((await readJournal(dir, 'conversation-1')).decisions[0].status, 'open');
  const second = await updateJournal(dir, 'conversation-1', update(1, 'T2', {
    requests: [{ id: 'R1', title: 'Deliver the improved feature' }],
  }));
  assert.equal(second.requests[0].title, 'Deliver the improved feature');
  assert.equal(second.decisions[0].status, 'open');
  assert.equal(second.blockers[0].status, 'open');
  assert.equal(second.history.length, 2);
  assert.equal(second.history[1].changes[0].before.title, 'Deliver the requested feature');
}));

test('blocker action URLs are optional and persist without resolving the blocker', async () => inTemp(async dir => {
  const first = await updateJournal(dir, 'conversation-1', update(0, 'T1', {
    requests: [request()], blockers: [blocker()],
  }));
  assert.equal(Object.hasOwn(first.blockers[0], 'action_url'), false);
  for (const action_url of ['https://accounts.example.com/login?return_to=%2Fworkspace', 'http://localhost:3000/access']) {
    const current = await readJournal(dir, 'conversation-1');
    await updateJournal(dir, 'conversation-1', update(current.revision, `T${current.revision + 1}`, {
      blockers: [{ id: 'B1', action_url }],
    }));
    const saved = await readJournal(dir, 'conversation-1');
    assert.equal(saved.blockers[0].action_url, action_url);
    assert.equal(saved.blockers[0].status, 'open');
    assert.equal(saved.requests[0].status, 'active');
  }
}));

test('writer rejects unsafe or malformed blocker action URLs without changing the saved file', async () => inTemp(async dir => {
  await updateJournal(dir, 'conversation-1', update(0, 'T1', {
    requests: [request()], blockers: [blocker()],
  }));
  const file = path.join(dir, 'conversation-1.json');
  const before = await fs.readFile(file, 'utf8');
  for (const action_url of [
    'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/access', 'ftp://example.com/access',
    '/login', '//example.com/login', 'not a URL', '', null, 42,
    'https://', 'https:///example.com/login', 'https://[invalid]/login', 'https://example.com:bad/login',
    ' https://example.com/login', 'https://example.com/log in', 'https://example.com/\\login',
    'https://example.com/\nlogin',
  ]) {
    await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
      blockers: [{ id: 'B1', action_url }],
    })), error => error.code === 'INVALID_BLOCKER', JSON.stringify(action_url));
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
}));

test('rejects an invalid update without changing the saved file', async () => inTemp(async dir => {
  await updateJournal(dir, 'conversation-1', update(0, 'T1', { requests: [request()] }));
  const file = path.join(dir, 'conversation-1.json');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    requests: [{ id: 'R1', status: 'done' }],
  })), error => error.code === 'MISSING_EVIDENCE');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await readJournal(dir, 'conversation-1')).revision, 1);
}));

test('rejects stale revisions, duplicate ids, missing references, and cycles', async () => inTemp(async dir => {
  await updateJournal(dir, 'conversation-1', update(0, 'T1', { requests: [request()] }));
  await assert.rejects(updateJournal(dir, 'conversation-1', update(0, 'T2')), error => error.code === 'STALE_REVISION');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    requests: [request('R2'), request('R2')],
  })), error => error.code === 'DUPLICATE_ID');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    decisions: [decision({ request_id: 'missing' })],
  })), error => error.code === 'MISSING_REFERENCE');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    requests: [{ id: 'R1', parent_id: 'R2' }, request('R2', { parent_id: 'R1' })],
  })), error => error.code === 'PARENT_CYCLE');
}));

test('rejects path traversal and does not leave the data directory', async () => inTemp(async dir => {
  await assert.rejects(readJournal(dir, '../outside'), error => error.code === 'INVALID_ID');
  await assert.rejects(updateJournal(dir, 'a/b', update(0, 'T1')), error => error.code === 'INVALID_ID');
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('refuses material decision edits without a new revision and stale answers after revision', async () => inTemp(async dir => {
  await updateJournal(dir, 'conversation-1', update(0, 'T1', {
    requests: [request()], decisions: [decision()],
  }));
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    decisions: [{ id: 'D1', question: 'A changed question?' }],
  })), error => error.code === 'DECISION_REVISION_REQUIRED');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 0, source: 'user:2', option_id: 'A' } }],
  })), error => error.code === 'STALE_ANSWER');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2', {
    decisions: [{ id: 'D1', status: 'answered' }],
  })), error => error.code === 'MISSING_ANSWER');
  const revised = await updateJournal(dir, 'conversation-1', update(1, 'T2', {
    decisions: [{ id: 'D1', revision: 2, question: 'A changed question?' }],
  }));
  assert.equal(revised.decisions[0].revision, 2);
  assert.equal(revised.history[1].changes[0].before.question, 'Which option?');
  await assert.rejects(updateJournal(dir, 'conversation-1', update(2, 'T3', {
    decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: 'user:3', option_id: 'A' } }],
  })), error => error.code === 'STALE_ANSWER');
  const answered = await updateJournal(dir, 'conversation-1', update(2, 'T3', {
    decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 2, source: 'user:3', option_id: 'B' } }],
  }));
  assert.equal(answered.decisions[0].user_answer.option_id, 'B');
  const changedAgain = await updateJournal(dir, 'conversation-1', update(3, 'T4', {
    decisions: [{ id: 'D1', revision: 3, options: [{ id: 'C', label: 'C', impact: 'New effect' }] }],
  }));
  assert.equal(changedAgain.decisions[0].status, 'open');
  assert.equal(changedAgain.decisions[0].user_answer, null);
  assert.equal(changedAgain.history[3].changes[0].before.user_answer.option_id, 'B');
}));

test('stop gate refuses a checkpoint that leaves authorized work active without a boundary', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'conversation-1', update(0, 'T1', {
    requests: [request('R1', { title: 'Updated specification' })],
  }, 'complete'));
  assert.deepEqual(evaluateStop(state, { turnId: 'T0' }), { allowed: false, reason: 'no saved checkpoint for this turn' });
  assert.equal(evaluateStop(state, { turnId: 'T0', stopHookActive: false }).allowed, false);
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, false);
  assert.match(evaluateStop(state, { turnId: 'T1' }).reason, /active or waiting/);
  const answered = await updateJournal(dir, 'conversation-1', update(1, 'T2', {}, 'answer_delivered'));
  assert.equal(evaluateStop(answered, { turnId: 'T2' }).allowed, false);
}));

test('stop gate accepts a recorded blocker or explicit user pause', async () => inTemp(async dir => {
  const blocked = await updateJournal(dir, 'conversation-1', update(0, 'T1', {
    requests: [request()], blockers: [blocker()],
  }, 'blocker'));
  assert.equal(evaluateStop(blocked, { turnId: 'T1' }).allowed, true);
  const paused = await updateJournal(dir, 'conversation-1', update(1, 'T2', {}, 'user_paused', {
    source: 'user:2', pause_source: 'user:2',
  }));
  assert.equal(evaluateStop(paused, { turnId: 'T2' }).allowed, true);
  const unsupported = await updateJournal(dir, 'conversation-1', update(2, 'T3', {}, 'user_paused', {
    source: 'user:3',
  }));
  assert.equal(evaluateStop(unsupported, { turnId: 'T3' }).allowed, false);
}));

test('exclusive lock refuses competing writers without modifying the file', async () => inTemp(async dir => {
  await updateJournal(dir, 'conversation-1', update(0, 'T1', { requests: [request()] }));
  const lock = path.join(dir, 'conversation-1.json.lock');
  await fs.writeFile(lock, 'held');
  try {
    await assert.rejects(updateJournal(dir, 'conversation-1', update(1, 'T2')), error => error.code === 'LOCKED');
    assert.equal((await readJournal(dir, 'conversation-1')).revision, 1);
  } finally {
    await fs.rm(lock);
  }
}));

test('validator rejects done requests without completion evidence', () => {
  assert.throws(() => validateJournal({
    schema_version: 1, revision: 0, conversation_id: 'c',
    requests: [request('R1', { status: 'done' })], decisions: [], blockers: [], turn: null, history: [],
  }), error => error.code === 'MISSING_EVIDENCE');
});

test('CLI reads, updates, and validates using the configured data directory', async () => inTemp(async dir => {
  const input = path.join(dir, 'update.json');
  await fs.writeFile(input, JSON.stringify(update(0, 'T1', { requests: [request()] })));
  const env = { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir };
  const changed = await runFile(process.execPath, [cliPath, 'update', '--conversation', 'conversation-1', '--input', input], { env });
  assert.equal(JSON.parse(changed.stdout).revision, 1);
  const read = await runFile(process.execPath, [cliPath, 'read', '--conversation', 'conversation-1'], { env });
  assert.equal(JSON.parse(read.stdout).requests[0].id, 'R1');
  const checked = await runFile(process.execPath, [cliPath, 'validate', '--conversation', 'conversation-1', '--data-dir', dir], { env });
  assert.deepEqual(JSON.parse(checked.stdout), { valid: true, conversation_id: 'conversation-1', revision: 1 });
}));

// Regressions for the bounded handoff. The journal diagnoses recorded state;
// these fixtures do not prove that a referenced user statement or run is real.
test('optional, unspecified, and parked decisions cannot justify stopping active work', async () => inTemp(async dir => {
  let state = await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request(), request('R2', { status: 'deferred' })],
    decisions: [decision({ required: false })],
  }, 'decision'));
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, false);
  state = await updateJournal(dir, 'c', update(1, 'T2', {
    decisions: [{ id: 'D1', revision: 2, required: null }],
  }, 'decision'));
  assert.equal(evaluateStop(state, { turnId: 'T2' }).allowed, false);
  state = await updateJournal(dir, 'c', update(2, 'T3', {
    decisions: [{ id: 'D1', revision: 3, request_id: 'R2', required: true }],
  }, 'decision'));
  assert.equal(evaluateStop(state, { turnId: 'T3' }).allowed, false);
}));

test('all active or waiting scopes need boundaries, not just one blocked branch', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request(), request('R2', { status: 'waiting' })], blockers: [blocker()],
  }, 'blocker'));
  const gate = evaluateStop(state, { turnId: 'T1' });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /R2/);
  const covered = await updateJournal(dir, 'c', update(1, 'T2', {
    decisions: [decision({ request_id: 'R2', required: true })],
  }, 'blocker'));
  assert.equal(evaluateStop(covered, { turnId: 'T2' }).allowed, true);
  const answered = await updateJournal(dir, 'c', update(2, 'T3', {
    decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: 'user:3', option_id: 'A' } }],
  }, 'blocker'));
  assert.equal(evaluateStop(answered, { turnId: 'T3' }).allowed, false);
}));

test('a parent link does not silently broaden the scope of a blocker', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request(), request('R2', { parent_id: 'R1' })], blockers: [blocker()],
  }, 'blocker'));
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, false);
}));

test('continuing runs require evidence, current observation, and coverage of remaining work', async () => inTemp(async dir => {
  let revision = 0;
  const good = { id: 'runner/session-7', status: 'running', request_ids: ['R1'], evidence: 'runner:observation-7' };
  for (const run of [
    { id: 'run-1', status: 'running' },
    { ...good, observed_turn_id: 'old' },
    { ...good, status: 'submitted' },
    { ...good, evidence: null },
  ]) {
    const id = `T${revision + 1}`;
    const state = await updateJournal(dir, 'c', update(revision, id, revision ? {} : { requests: [request()] }, 'background', {
      continuing_run: { observed_turn_id: id, ...run },
    }));
    assert.equal(evaluateStop(state, { turnId: id }).allowed, false);
    revision++;
  }
  let state = await updateJournal(dir, 'c', update(revision++, 'T5', {}, 'background', {
    continuing_run: { ...good, observed_turn_id: 'T5', model: null },
  }));
  assert.equal(evaluateStop(state, { turnId: 'T5' }).allowed, true);
  state = await updateJournal(dir, 'c', update(revision, 'T6', { requests: [request('R2')] }, 'background', {
    continuing_run: { ...good, observed_turn_id: 'T6' },
  }));
  assert.equal(evaluateStop(state, { turnId: 'T6' }).allowed, false);
}));

test('an inactive-hook hint cannot turn unfinished work into a valid stop', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }, 'complete'));
  assert.equal(evaluateStop(state, { turnId: 'T1', stopHookActive: false }).allowed, false);
}));

test('complete and answer-only turns do not force proposed or deferred work to execute', async () => inTemp(async dir => {
  let state = await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request('R1', { status: 'proposed', origin: 'agent' }), request('R2', { status: 'deferred' })],
    decisions: [decision({ required: true })],
  }, 'complete'));
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, true);
  state = await updateJournal(dir, 'c', update(1, 'T2', {}, 'answer_delivered'));
  assert.equal(evaluateStop(state, { turnId: 'T2' }).allowed, true);
}));

test('explicit pause takes precedence over uncovered work, but not over turn freshness', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request(), request('R2')],
  }, 'user_paused', { source: 'user:stop', pause_source: 'user:stop' }));
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, true);
  assert.equal(evaluateStop(state, { turnId: 'T2' }).allowed, false);
}));

test('a previous turn cannot overwrite a newer turn even with a fresh revision', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  await updateJournal(dir, 'c', update(1, 'T1')); // Several checkpoints within one human turn are valid.
  await updateJournal(dir, 'c', update(2, 'T2'));
  await assert.rejects(updateJournal(dir, 'c', update(3, 'T1')), error => error.code === 'STALE_TURN');
  assert.equal((await readJournal(dir, 'c')).turn.id, 'T2');
}));

test('interrupted and unknown observations can be recorded without claiming completion', async () => inTemp(async dir => {
  for (const [index, reason] of ['interrupted', 'unknown'].entries()) {
    const id = `T${index + 1}`;
    const state = await updateJournal(dir, 'c', update(index, id, index ? {} : { requests: [request()] }, reason));
    assert.equal(evaluateStop(state, { turnId: id }).allowed, false);
    assert.equal(state.requests[0].status, 'active');
  }
}));

test('20 human turns preserve the original request, branching, and unanswered decisions on cold reopen', async () => inTemp(async dir => {
  const original = request('R1', { source: 'user:original', origin: 'user', scope: 'review only; no deployment' });
  let state;
  for (let n = 1; n <= 20; n++) {
    const patch = n === 1 ? { requests: [original], decisions: [decision({ required: true })] }
      : n === 2 ? { requests: [request('R2', { parent_id: 'R1', source: 'user:branch' })], decisions: [decision({ id: 'D2', required: false }), decision({ id: 'D3', required: true })] }
      : n === 8 ? { decisions: [{ id: 'D2', status: 'answered', user_answer: { revision: 1, source: 'user:8', option_id: 'B' } }] }
      : n === 12 ? { requests: [{ id: 'R2', status: 'done', evidence: 'artifact:branch-report' }] }
      : {};
    state = await updateJournal(dir, 'c', update(n - 1, `T${n}`, patch, 'answer_delivered', {
      source: `user:${n}`, summary: `Answered clarification ${n}; original review remains`, model: null,
    }));
    assert.equal(state.revision, n);
    assert.equal(evaluateStop(state, { turnId: `T${n}` }).allowed, false);
    assert.equal((await readJournal(dir, 'c')).requests[0].scope, original.scope);
  }
  // A separate Node process imports the store afresh; no in-memory state survives.
  const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;
  const fresh = await runFile(process.execPath, ['--input-type=module', '-e',
    `import { readJournal } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await readJournal(process.argv[1], 'c')));`, dir]);
  const reopened = JSON.parse(fresh.stdout);
  assert.deepEqual(reopened, state);
  assert.equal(reopened.requests.length, 2); // Clarifications are not manufactured Requests.
  assert.deepEqual(reopened.decisions.map(d => [d.id, d.status]), [['D1', 'open'], ['D2', 'answered'], ['D3', 'open']]);
  assert.equal(reopened.history.length, 20);
  assert.equal(reopened.history[0].changes[0].after.source, 'user:original');
  assert.equal(reopened.history.at(-1).changes.at(-1).after.source, 'user:20');
}));

test('reading a missing journal is non-mutating and conversations remain isolated', async () => inTemp(async dir => {
  const nonexistent = path.join(dir, 'absent');
  const empty = await readJournal(nonexistent, 'c');
  assert.equal(empty.revision, 0);
  await assert.rejects(fs.access(nonexistent), error => error.code === 'ENOENT');
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  assert.equal((await readJournal(dir, 'another')).revision, 0);
  assert.deepEqual((await readJournal(dir, 'another')).requests, []);
}));

test('unchanged record patches do not expand semantic history', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const state = await updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R1', title: request().title }] }));
  assert.equal(state.history.length, 2);
  assert.deepEqual(state.history[1].changes.map(c => c.collection), ['turn']);
}));

test('changed requiredness, situation, or scope invalidates a decision revision, not its history', async () => inTemp(async dir => {
  const assumption = { text: 'Prefer A provisionally', source: 'agent:1' };
  await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request()], decisions: [decision({
      required: false, current_situation: 'Preview only', scope: { environment: 'staging' },
      status: 'answered', user_answer: { revision: 1, source: 'user:1', option_id: 'A' }, agent_assumption: assumption,
    })],
  }));
  for (const patch of [{ required: true }, { current_situation: 'Apply now' }, { scope: { environment: 'production' } }]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', ...patch }] })),
      error => error.code === 'DECISION_REVISION_REQUIRED');
  }
  const state = await updateJournal(dir, 'c', update(1, 'T2', {
    decisions: [{ id: 'D1', revision: 2, required: true, current_situation: 'Apply now' }],
  }));
  assert.equal(state.decisions[0].user_answer, null);
  assert.equal(state.decisions[0].status, 'open');
  assert.deepEqual(state.decisions[0].agent_assumption, assumption);
  assert.equal(state.history[1].changes[0].before.user_answer.source, 'user:1');
}));

test('decision requiredness is boolean or unknown, and a textual answer need not name an option', async () => inTemp(async dir => {
  await assert.rejects(updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request()], decisions: [decision({ required: 'true' })],
  })), error => error.code === 'INVALID_DECISION');
  const state = await updateJournal(dir, 'c', update(0, 'T1', {
    requests: [request()], decisions: [decision({ required: null, status: 'answered',
      user_answer: { revision: 1, source: 'user:1', option_id: null, text: 'Neither; keep the current route.' } })],
  }));
  assert.equal(state.decisions[0].user_answer.option_id, null);
}));

test('materially changed or reopened requests cannot reuse implicit old completion evidence', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request('R1', { status: 'done', evidence: 'old-result' })] }, 'complete'));
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R1', done_when: 'Verify an additional outcome' }] })),
    error => error.code === 'MISSING_EVIDENCE');
  await updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R1', status: 'active' }] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { requests: [{ id: 'R1', status: 'done' }] })),
    error => error.code === 'MISSING_EVIDENCE');
  const state = await updateJournal(dir, 'c', update(2, 'T3', { requests: [{ id: 'R1', status: 'done', evidence: 'new-result' }] }, 'complete'));
  assert.equal(evaluateStop(state, { turnId: 'T3' }).allowed, true);
}));

test('parent completion requires remaining child scope to be resolved or explicitly excluded', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request(), request('R2', { parent_id: 'R1', status: 'deferred' })] }));
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R1', status: 'done', evidence: 'parent-result' }] })),
    error => error.code === 'UNFINISHED_CHILD');
  const state = await updateJournal(dir, 'c', update(1, 'T2', { requests: [
    { id: 'R1', status: 'done', evidence: 'parent-result' },
    { id: 'R2', scope_exclusion_source: 'user:2:exclude-child-from-parent' },
  ] }, 'complete'));
  assert.equal(state.requests[1].status, 'deferred');
  assert.equal(evaluateStop(state, { turnId: 'T2' }).allowed, true);
}));

test('an unaccepted child proposal does not prevent finishing the authorized parent', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'c', update(0, 'T1', { requests: [
    request('R1', { status: 'done', evidence: 'artifact:result' }),
    request('R2', { parent_id: 'R1', status: 'proposed', origin: 'agent' }),
  ] }, 'complete'));
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, true);
}));

test('updates are isolated from caller mutation across asynchronous file operations', async () => inTemp(async dir => {
  const payload = update(0, 'T1', { requests: [request()] });
  const pending = updateJournal(dir, 'c', payload);
  payload.turn.summary = 'Mutated after submission';
  payload.upsert.requests[0].title = 'Mutated original';
  const state = await pending;
  assert.equal(state.turn.summary, 'Recorded current work');
  assert.equal(state.requests[0].title, request().title);
  assert.deepEqual(await readJournal(dir, 'c'), state);
}));

test('non-JSON updates and unsupported top-level deletion instructions are rejected without a commit', async () => inTemp(async dir => {
  for (const metadata of [undefined, NaN, Infinity, () => {}, 1n, new Date()]) {
    await assert.rejects(updateJournal(dir, 'c', update(0, 'T1', { requests: [request('R1', { metadata })] })),
      error => error.code === 'INVALID_UPDATE');
  }
  await assert.rejects(updateJournal(dir, 'c', { ...update(0, 'T1'), delete: { requests: ['R1'] } }),
    error => error.code === 'INVALID_UPDATE');
  assert.equal((await readJournal(dir, 'c')).revision, 0);
}));

test('history rejects gaps, disconnected before-values, and a snapshot inconsistent with its last commit', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const original = await updateJournal(dir, 'c', update(1, 'T2'));
  const corruptions = [
    state => { state.history = []; },
    state => { state.history[0].revision = 2; },
    state => { state.history[1].turn_id = 'other'; },
    state => { state.turn.summary = 'Unsaved turn'; },
    state => { state.history[0].changes[0].before = request(); },
    state => { state.requests = []; },
  ];
  for (const corrupt of corruptions) {
    // Disk JSON has no shared references between the snapshot and history.
    const changed = JSON.parse(JSON.stringify(original));
    corrupt(changed);
    assert.throws(() => validateJournal(changed), error => error.code === 'INVALID_HISTORY');
  }
}));

test('unsafe conversation and record identifiers cannot escape the journal directory', async () => inTemp(async dir => {
  for (const id of ['..', '.', '', '../escape', 'a/b', 'a\\b', 'a\0b', 'a?b', 'a'.repeat(129)]) {
    await assert.rejects(readJournal(dir, id), error => error.code === 'INVALID_ID');
    await assert.rejects(updateJournal(dir, id, update(0, 'T1')), error => error.code === 'INVALID_ID');
  }
  await assert.rejects(updateJournal(dir, 'c', update(0, 'T1', { requests: [request('../escape')] })),
    error => error.code === 'INVALID_ID');
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('corrupt JSON and mismatched conversation identity are not reset or overwritten', async () => inTemp(async dir => {
  const file = path.join(dir, 'c.json');
  await fs.writeFile(file, '{interrupted');
  await assert.rejects(readJournal(dir, 'c'), error => error.code === 'INVALID_JSON');
  await assert.rejects(updateJournal(dir, 'c', update(0, 'T1')), error => error.code === 'INVALID_JSON');
  assert.equal(await fs.readFile(file, 'utf8'), '{interrupted');
  const other = await updateJournal(dir, 'other', update(0, 'T1', { requests: [request()] }));
  await fs.writeFile(file, JSON.stringify(other));
  await assert.rejects(readJournal(dir, 'c'), error => error.code === 'INVALID_STATE');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['c.json', 'other.json']);
}));

test('journal symlinks, including dangling ones, are refused rather than read as state', { skip: process.platform === 'win32' }, async () => inTemp(async dir => {
  const outside = path.join(dir, 'outside.json');
  const journals = path.join(dir, 'journals');
  await fs.mkdir(journals);
  await fs.writeFile(outside, JSON.stringify({ secret: 'not-journal-state' }));
  const file = path.join(journals, 'c.json');
  for (const target of [outside, path.join(dir, 'missing.json')]) {
    await fs.symlink(target, file);
    await assert.rejects(readJournal(journals, 'c'), error => error.code === 'UNSAFE_PATH');
    await assert.rejects(updateJournal(journals, 'c', update(0, 'T1')), error => error.code === 'UNSAFE_PATH');
    assert.equal(await fs.readlink(file), target);
    await fs.unlink(file);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(outside, 'utf8')), { secret: 'not-journal-state' });
}));

test('new state files and their data directory are private on POSIX', { skip: process.platform === 'win32' }, async () => inTemp(async dir => {
  const data = path.join(dir, 'private');
  await updateJournal(data, 'c', update(0, 'T1', { requests: [request()] }));
  assert.equal((await fs.stat(path.join(data, 'c.json'))).mode & 0o077, 0);
  assert.equal((await fs.stat(data)).mode & 0o077, 0);
}));

test('failed atomic replacement preserves the committed file and cleans up its own lock and temp', async t => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const file = path.join(dir, 'c.json');
  const before = await fs.readFile(file, 'utf8');
  const rename = t.mock.method(fs, 'rename', async (from, to) => {
    assert.equal(to, file);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    const pending = JSON.parse(await fs.readFile(from, 'utf8'));
    assert.equal(validateJournal(pending).revision, 2);
    throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
  });
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2')), error => error.code === 'EIO');
  rename.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(dir), ['c.json']);
  assert.equal((await updateJournal(dir, 'c', update(1, 'T2'))).revision, 2);
}));

test('a failed temp cleanup still releases the owned lock and preserves the primary error', async t => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const realRm = fs.rm;
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); });
  const rm = t.mock.method(fs, 'rm', async (file, options) => {
    if (file.endsWith('.tmp')) throw Object.assign(new Error('temp cleanup failed'), { code: 'EACCES' });
    return realRm(file, options);
  });
  try {
    await assert.rejects(updateJournal(dir, 'c', update(1, 'T2')), error => error.code === 'EIO');
  } finally {
    rename.mock.restore();
    rm.mock.restore();
  }
  const files = await fs.readdir(dir);
  assert.equal(files.some(name => name.endsWith('.lock')), false);
  assert.equal((await readJournal(dir, 'c')).revision, 1);
}));

test('independent CLI processes compete with CAS and never lose an accepted update', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const inputs = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const input = path.join(dir, `input-${index}.json`);
    await fs.writeFile(input, JSON.stringify(update(1, `T2-${index}`, { requests: [request(`R${index + 2}`)] })));
    return input;
  }));
  const results = await Promise.allSettled(inputs.map(input => runFile(process.execPath,
    [cliPath, 'update', '--conversation', 'c', '--data-dir', dir, '--input', input])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.match(result.reason.stderr, /LOCKED|STALE_REVISION/);
    assert.equal(result.reason.stdout, '');
  }
  const state = await readJournal(dir, 'c');
  assert.equal(state.revision, 2);
  assert.equal(state.requests.length, 2);
  assert.equal(state.history.length, 2);
  assert.equal((await fs.readdir(dir)).some(name => /\.(tmp|lock)$/.test(name)), false);
}));

test('abrupt process exit before rename leaves the old state readable and does not steal an orphan lock', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const storeUrl = new URL('../src/store.mjs', import.meta.url).href;
  const script = `import { promises as fs } from 'node:fs';
    import { updateJournal } from ${JSON.stringify(storeUrl)};
    fs.rename = async () => { process.exit(73); };
    await updateJournal(process.argv[1], 'c', ${JSON.stringify(update(1, 'T2'))});`;
  await assert.rejects(runFile(process.execPath, ['--input-type=module', '-e', script, dir]), error => error.code === 73);
  assert.equal((await readJournal(dir, 'c')).revision, 1);
  assert.ok((await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
  assert.ok((await fs.readdir(dir)).includes('c.json.lock'));
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T3')), error => error.code === 'LOCKED');
}));

test('CLI validate distinguishes valid stored JSON from a justified stop and checks the current turn', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }, 'answer_delivered'));
  const args = [cliPath, 'validate', '--conversation', 'c', '--data-dir', dir, '--turn', 'T1'];
  await assert.rejects(runFile(process.execPath, args), error => {
    assert.equal(error.code, 2);
    const result = JSON.parse(error.stdout);
    assert.equal(result.valid, true);
    assert.equal(result.stop.allowed, false);
    assert.match(result.stop.reason, /R1/);
    assert.equal(error.stderr, '');
    return true;
  });
  await updateJournal(dir, 'c', update(1, 'T2', { blockers: [blocker()] }, 'blocker'));
  const checked = await runFile(process.execPath, [...args.slice(0, -1), 'T2']);
  assert.equal(JSON.parse(checked.stdout).stop.allowed, true);
  await assert.rejects(runFile(process.execPath, args), error => error.code === 2 && JSON.parse(error.stdout).stop.allowed === false);
}));

test('CLI rejects bad arguments and invalid input without writing or printing success', async () => inTemp(async dir => {
  const input = path.join(dir, 'bad-input.json');
  await fs.writeFile(input, '{bad json');
  const env = { ...process.env };
  delete env.REQUEST_JOURNAL_DATA_DIR;
  for (const args of [
    [], ['bogus'], ['read', '--conversation', 'c'],
    ['read', '--conversation', 'c', '--data-dir', dir, '--input', input],
    ['read', '--conversation', 'c', '--data-dir', dir, '--turn', 'T1'],
    ['validate', '--conversation', 'c', '--data-dir', dir, '--turn'],
    ['read', '--conversation', 'c', '--conversation', 'c', '--data-dir', dir],
    ['update', '--conversation', 'c', '--data-dir', dir, '--input', input],
  ]) {
    await assert.rejects(runFile(process.execPath, [cliPath, ...args], { env }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.ok(error.stderr.length > 0);
      return true;
    });
  }
  assert.deepEqual(await fs.readdir(dir), ['bad-input.json']);
}));

test('continuing-run scope references and optional observation fields are validated', async () => inTemp(async dir => {
  const base = { id: 'runner/session-1', status: 'running', observed_turn_id: 'T1', evidence: 'runner:receipt-1' };
  for (const fields of [
    { request_ids: ['missing'] }, { request_ids: ['R1', 'R1'] }, { request_ids: 'R1' },
    { request_ids: ['../escape'] }, { request_ids: ['R1'], observed_turn_id: 1 },
    { request_ids: ['R1'], evidence: {} },
  ]) {
    await assert.rejects(updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }, 'background', {
      continuing_run: { ...base, ...fields },
    })), error => ['INVALID_TURN', 'MISSING_REFERENCE', 'INVALID_ID'].includes(error.code));
  }
  assert.equal((await readJournal(dir, 'c')).revision, 0);
}));

test('a cleanup error after rename does not erase the committed result; retry must reread', async t => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const realRm = fs.rm;
  const rm = t.mock.method(fs, 'rm', async (file, options) => {
    if (file.endsWith('.lock')) throw Object.assign(new Error('lock cleanup failed'), { code: 'EACCES' });
    return realRm(file, options);
  });
  try {
    await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', {
      requests: [{ id: 'R1', status: 'done', evidence: 'artifact:actual-result' }],
    }, 'complete')), error => error.code === 'EACCES');
  } finally {
    rm.mock.restore();
  }
  const recovered = await readJournal(dir, 'c');
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.requests[0].evidence, 'artifact:actual-result');
  assert.equal(evaluateStop(recovered, { turnId: 'T2' }).allowed, true);
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2')), error => error.code === 'LOCKED');
}));

test('an exclusion from one parent is not silently reused after reparenting', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [
    request('R1'), request('R2', { parent_id: 'R1', status: 'deferred', scope_exclusion_source: 'user:exclude-from-R1' }),
    request('R3', { status: 'done', evidence: 'artifact:R3-result' }),
  ] }));
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R2', parent_id: 'R3' }] })),
    error => error.code === 'UNFINISHED_CHILD');
  const state = await updateJournal(dir, 'c', update(1, 'T2', { requests: [{
    id: 'R2', parent_id: 'R3', scope_exclusion_source: 'user:exclude-from-R3',
  }] }));
  assert.equal(state.requests[1].scope_exclusion_source, 'user:exclude-from-R3');
  assert.equal(state.history[1].changes[0].before.scope_exclusion_source, 'user:exclude-from-R1');
}));

const card = (extras = {}) => ({
  id: 'C1', request_id: 'R1', revision: 1, type: 'suggestion', title: 'A useful option',
  body: 'This preference is optional.', source: 'agent:1', status: 'open',
  options: [{ id: 'A', label: 'A', impact: 'First effect' }], ...extras,
});
const reply = (items, extras = {}) => ({ id: 'delivery-1', source: 'user:received-1', items, ...extras });
const replyItem = (extras = {}) => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', outcome: 'accepted', option_id: 'A', ...extras });

test('version-1 ledgers default new collections without rewriting old records or history', async () => inTemp(async dir => {
  const state = await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  delete state.cards;
  delete state.replies;
  const file = path.join(dir, 'c.json');
  const original = `${JSON.stringify(state, null, 1)}\n`;
  await fs.writeFile(file, original);
  assert.equal(validateJournal(state), state);
  const read = await readJournal(dir, 'c');
  assert.deepEqual(read.cards, []);
  assert.deepEqual(read.replies, []);
  assert.deepEqual(read.history, state.history);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const changed = await updateJournal(dir, 'c', update(1, 'T2', { cards: [card()] }));
  assert.deepEqual(changed.history[0], state.history[0]);
  assert.deepEqual(changed.requests, state.requests);
  assert.deepEqual(changed.decisions, state.decisions);
  assert.equal((await readJournal(dir, 'c')).cards[0].id, 'C1');
}));

test('material card edits advance revision and invalidate old answers', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], cards: [card({
    status: 'answered', user_answer: { revision: 1, source: 'user:1', option_id: 'A' },
  })] }));
  for (const patch of [{ title: 'Changed title' }, { body: 'Changed context' }, { source: 'agent:2' }, { metadata: { effect: 'new' } }]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { cards: [{ id: 'C1', ...patch }] })), error => error.code === 'CARD_REVISION_REQUIRED');
  }
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { cards: [{ id: 'C1', revision: 3 }] })), error => error.code === 'CARD_REVISION_REQUIRED');
  const changed = await updateJournal(dir, 'c', update(1, 'T2', { cards: [{ id: 'C1', revision: 2, body: 'Changed context' }] }));
  assert.equal(changed.cards[0].status, 'open');
  assert.equal(changed.cards[0].user_answer, null);
  assert.equal(changed.history[1].changes[0].before.user_answer.source, 'user:1');
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { cards: [{ id: 'C1', status: 'answered', user_answer: { revision: 1, source: 'user:3', option_id: 'A' } }] })), error => error.code === 'STALE_ANSWER');
}));

test('cards require references and valid type-specific fields; suggestions never authorize stopping', async () => inTemp(async dir => {
  for (const invalid of [card({ request_id: 'missing' }), card({ source: '' }), card({ type: 'unknown' }), card({ revision: 0 }), card({ type: 'qa' }), card({ type: 'note', user_answer: null })]) {
    await assert.rejects(updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], cards: [invalid] })), error => ['MISSING_REFERENCE', 'INVALID_CARD'].includes(error.code));
  }
  const { options, ...plain } = card();
  const state = await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], cards: [
    card({ required: true }), { ...plain, id: 'C2', type: 'qa' }, { ...plain, id: 'C3', type: 'note' },
  ] }, 'decision'));
  assert.equal(evaluateStop(state, { turnId: 'T1' }).allowed, false);
  assert.deepEqual((await readJournal(dir, 'c')).cards, state.cards);
}));

test('reply answers bind the journal change revision and commit with a semantic answer atomically', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2'));
  await updateJournal(dir, 'c', update(2, 'T3', { decisions: [{ id: 'D1', revision: 2, question: 'Changed question?' }] }));
  await assert.rejects(updateJournal(dir, 'c', update(3, 'T4', { replies: [reply([replyItem({ record_revision: 2 })])] })), error => error.code === 'MISSING_REPLY_TARGET');
  const receipt = reply([replyItem({ record_revision: 3 })]);
  const saved = await updateJournal(dir, 'c', update(3, 'T4', {
    replies: [receipt], decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 2, source: receipt.source, option_id: 'A' } }],
  }));
  assert.deepEqual(saved.replies, [receipt]);
  assert.equal(saved.decisions[0].status, 'answered');
  assert.deepEqual((await readJournal(dir, 'c')).replies, [receipt]);
}));

test('historical comments retain their target and never resolve work or choices', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()], blockers: [blocker()], cards: [card()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R1', title: 'Revised request' }], decisions: [{ id: 'D1', revision: 2, question: 'Revised choice?' }] }));
  const receipt = reply(['requests', 'decisions', 'blockers', 'cards'].map((collection, index) => ({ collection, id: ['R1', 'D1', 'B1', 'C1'][index], record_revision: 1, kind: 'comment', text: 'This refers to the original wording.' })));
  const before = await readJournal(dir, 'c');
  const saved = await updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt] }));
  for (const collection of ['requests', 'decisions', 'blockers', 'cards']) assert.deepEqual(saved[collection], before[collection]);
  assert.deepEqual(saved.replies[0], receipt);
}));

test('a stale answer rejects its whole batch including otherwise valid historical comments', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', revision: 2, question: 'Revised choice?' }] }));
  const file = path.join(dir, 'c.json');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { replies: [reply([
    { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Valid earlier comment' }, replyItem(),
  ])], requests: [{ id: 'R1', title: 'Must not commit' }] })), error => error.code === 'STALE_REPLY');
  assert.equal(await fs.readFile(file, 'utf8'), before);
}));

test('stale answers remain in a receipt alongside accepted historical comments without applying them', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  const before = await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', revision: 2, question: 'Revised choice?' }] }));
  const receipt = reply([
    replyItem({ outcome: 'stale' }),
    { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', outcome: 'accepted', text: 'A valid historical comment' },
  ]);
  const saved = await updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt] }));
  assert.deepEqual(saved.decisions, before.decisions);
  assert.deepEqual(saved.requests, before.requests);
  assert.deepEqual(saved.replies, [receipt]);
  assert.deepEqual((await readJournal(dir, 'c')).replies, [receipt]);
}));

test('reply targets must exist historically and answers need an open choice and a valid value', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()], cards: [card()] }));
  for (const item of [replyItem({ id: 'missing' }), replyItem({ record_revision: 2 }), replyItem({ option_id: 'unknown' }), replyItem({ option_id: null, text: ' ' }), replyItem({ collection: 'requests', id: 'R1' })]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { replies: [reply([item])] })), error => ['MISSING_REPLY_TARGET', 'INVALID_REPLY'].includes(error.code));
  }
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { replies: [reply([replyItem({ outcome: 'stale' })])] })), error => error.code === 'INVALID_REPLY_OUTCOME');
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { cards: [card({ id: 'C2' })], replies: [reply([replyItem({ collection: 'cards', id: 'C2', record_revision: 2 })])] })), error => error.code === 'MISSING_REPLY_TARGET');
  const receipt = reply([replyItem({ collection: 'cards', id: 'C1', option_id: null, text: 'Keep the present approach.' })]);
  const answered = await updateJournal(dir, 'c', update(1, 'T2', { replies: [receipt], cards: [{ id: 'C1', status: 'answered', user_answer: { revision: 1, source: receipt.source, text: receipt.items[0].text } }] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { replies: [reply([replyItem({ collection: 'cards', id: 'C1', record_revision: 2 })], { id: 'delivery-2' })] })), error => error.code === 'INVALID_REPLY');
  assert.equal(answered.requests[0].status, 'active');
}));

test('receipts reject duplicate item bindings and choices that were already closed in the referenced version', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { replies: [reply([replyItem(), replyItem({ option_id: 'B' })])] })), error => error.code === 'INVALID_REPLY');
  const comment = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'One comment' };
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { replies: [reply([comment, { ...comment, text: 'Contradictory comment' }])] })), error => error.code === 'INVALID_REPLY');
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: 'user:2', option_id: 'A' } }] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { replies: [reply([replyItem({ record_revision: 2, outcome: 'stale' })])] })), error => error.code === 'INVALID_REPLY');
  const receipt = reply([replyItem({ outcome: 'stale' })]);
  const saved = await updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt] }));
  assert.deepEqual((await readJournal(dir, 'c')).replies, [receipt]);
  assert.equal(saved.decisions[0].user_answer.source, 'user:2');
}));

test('identical reply receipts are harmless after answer acknowledgement and changed receipts are rejected', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  const receipt = reply([replyItem()]);
  await updateJournal(dir, 'c', update(1, 'T2', { replies: [receipt], decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: receipt.source, option_id: 'A' } }] }));
  const repeated = await updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt] }));
  assert.equal(repeated.replies.length, 1);
  assert.deepEqual(repeated.history[2].changes.map(change => change.collection), ['turn']);
  const file = path.join(dir, 'c.json');
  const before = await fs.readFile(file, 'utf8');
  for (const changed of [{ ...receipt, source: 'user:other' }, reply([replyItem({ option_id: 'B' })]), { id: receipt.id }]) {
    await assert.rejects(updateJournal(dir, 'c', update(3, 'T4', { replies: [changed] })), error => error.code === 'IMMUTABLE_REPLY');
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
}));

test('history validates card revisions and receipt versions rather than only the final snapshot', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], cards: [card()] }));
  const saved = await updateJournal(dir, 'c', update(1, 'T2', { cards: [{ id: 'C1', revision: 2, body: 'Revised optional suggestion' }], replies: [reply([{ collection: 'cards', id: 'C1', record_revision: 1, kind: 'comment', text: 'Original suggestion comment' }])] }));
  const invalidCard = JSON.parse(JSON.stringify(saved));
  invalidCard.cards[0].revision = 1;
  invalidCard.history[1].changes.find(change => change.collection === 'cards').after.revision = 1;
  assert.throws(() => validateJournal(invalidCard), error => error.code === 'CARD_REVISION_REQUIRED');
  const invalidReply = JSON.parse(JSON.stringify(saved));
  invalidReply.replies[0].items[0].record_revision = 99;
  invalidReply.history[1].changes.find(change => change.collection === 'replies').after.items[0].record_revision = 99;
  assert.throws(() => validateJournal(invalidReply), error => error.code === 'MISSING_REPLY_TARGET');
}));

test('semantic answers citing an atomic receipt must match its accepted target and exact value', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision(), decision({ id: 'D2' })] }));
  const file = path.join(dir, 'c.json');
  const before = await fs.readFile(file, 'utf8');
  const receipt = reply([replyItem()]);
  for (const patch of [
    { id: 'D1', status: 'answered', user_answer: { revision: 1, source: receipt.source, option_id: 'B' } },
    { id: 'D2', status: 'answered', user_answer: { revision: 1, source: receipt.source, option_id: 'A' } },
    { id: 'D1', revision: 2, question: 'A different choice?', status: 'answered', user_answer: { revision: 2, source: receipt.source, option_id: 'A' } },
  ]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { replies: [receipt], decisions: [patch] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
  const commentReceipt = reply([{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'comment', text: 'Consider A' }]);
  await assert.rejects(updateJournal(dir, 'c', update(1, 'T2', { replies: [commentReceipt], decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: commentReceipt.source, option_id: 'A' } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const saved = await updateJournal(dir, 'c', update(1, 'T2', { replies: [receipt], decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: receipt.source, option_id: 'A' } }] }));
  assert.equal(saved.decisions[0].user_answer.option_id, 'A');
  assert.deepEqual(saved.replies, [receipt]);
}));

test('a stale receipt cannot supply provenance for accepting the changed choice', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', revision: 2, question: 'Changed choice?' }] }));
  const receipt = reply([replyItem({ outcome: 'stale' })]);
  const file = path.join(dir, 'c.json');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt], decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 2, source: receipt.source, option_id: 'A' } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const saved = await updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt], decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 2, source: 'user:separate-actual-answer', option_id: 'A' } }] }));
  assert.equal(saved.decisions[0].user_answer.source, 'user:separate-actual-answer');
  assert.deepEqual(saved.replies, [receipt]);
}));

test('Other answers must match receipt text and exact receipt matches can be applied separately', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], cards: [card()] }));
  const receipt = reply([replyItem({ collection: 'cards', id: 'C1', option_id: null, text: 'Keep the current approach.' })]);
  await updateJournal(dir, 'c', update(1, 'T2', { replies: [receipt] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt], cards: [{ id: 'C1', status: 'answered', user_answer: { revision: 1, source: receipt.source, text: 'Change the approach.' } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
  const saved = await updateJournal(dir, 'c', update(2, 'T3', { replies: [receipt], cards: [{ id: 'C1', status: 'answered', user_answer: { revision: 1, source: receipt.source, text: receipt.items[0].text } }] }));
  assert.equal(saved.cards[0].user_answer.text, receipt.items[0].text);
  const repeated = await updateJournal(dir, 'c', update(3, 'T4', { replies: [receipt], cards: [{ id: 'C1', status: 'answered', user_answer: saved.cards[0].user_answer }] }));
  assert.equal(repeated.replies.length, 1);
  assert.deepEqual(repeated.history[3].changes.map(change => change.collection), ['turn']);
}));

test('Decision auxiliary links retain original accepted answer binding and history replay', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', urls: [{ label: 'Help', url: 'https://example.com/help' }] }] }));
  const saved = await updateJournal(dir, 'c', update(2, 'T3', {
    replies: [reply([replyItem()])], decisions: [{ id: 'D1', status: 'answered',
      user_answer: { option_id: 'A', revision: 1, source: 'user:received-1' } }],
  }));
  assert.equal(saved.replies[0].items[0].record_revision, 1);
  assert.equal(saved.decisions[0].user_answer.option_id, 'A');
  assert.deepEqual(await readJournal(dir, 'c'), saved);
}));

test('Decision auxiliary-link version itself remains an eligible immutable receipt target', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', urls: [{ label: 'Help', url: 'https://example.com/help' }] }] }));
  const saved = await updateJournal(dir, 'c', update(2, 'T3', { replies: [reply([replyItem({ record_revision: 2 })])] }));
  assert.equal(saved.replies[0].items[0].record_revision, 2);
}));

test('cosmetic links do not preserve action eligibility across a real Decision revision', async () => inTemp(async dir => {
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', urls: [{ label: 'Help', url: 'https://example.com/help' }] }] }));
  await updateJournal(dir, 'c', update(2, 'T3', { decisions: [{ id: 'D1', revision: 2, question: 'A changed choice?' }] }));
  await assert.rejects(updateJournal(dir, 'c', update(3, 'T4', { replies: [reply([replyItem()])] })), error => error.code === 'STALE_REPLY');
}));
