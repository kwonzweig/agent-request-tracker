import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { demoFixtures } from '../scripts/demo-fixtures.mjs';
import { evaluateStop, validateJournal } from '../src/store.mjs';
import { attentionItems, needsAttention } from '../src/journal-views.mjs';
import { journalAt } from '../src/reply-ui.mjs';
import { evaluateCompletion } from '../src/completion.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const directives = document => new Map(document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  .split(';').map(value => value.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...values]) => [name, values]));

async function generatedDemo() {
  const html = await readFile(new URL('../docs-site/public/demo.html', import.meta.url), 'utf8');
  const outer = parseHTML(html).document;
  const frame = outer.querySelector('iframe');
  assert.ok(frame?.hasAttribute('srcdoc'), 'public demo must embed its own document');
  const innerSource = frame.getAttribute('srcdoc');
  // linkedom retains CRLF, but browser HTML parsing normalizes both script and
  // style bytes to LF before checking CSP hashes. Model that browser behavior.
  const inner = parseHTML(innerSource.replace(/\r\n?/g, '\n'));
  return { outer, frame, innerSource, window: inner.window, document: inner.document };
}

test('the actual displayed demo snapshots keep writer-valid history and receipt bindings', async () => {
  const demo = await runGeneratedDemo(), fixtures = await demoFixtures();
  for (const name of ['open', 'later', 'reopened', 'closed', 'open']) {
    if (name !== 'open' || demo.snapshot().revision !== fixtures.open.revision) await demo.scenario(name);
    const displayed = demo.snapshot();
    validateJournal(displayed);
    assert.deepEqual(displayed, fixtures[name]);
  }
});

test('writer-created demo fixtures retain Later, a sourced reopening and historical cards', async () => {
  const fixtures = await demoFixtures(), { open, later, reopened, closed } = fixtures;
  for (const [name, state] of Object.entries(fixtures)) {
    validateJournal(state);
    assert.equal(state.conversation_id, 'fictional-weekly-digest');
    assert.equal(state.requests.find(record => record.id === 'R1').status, name === 'closed' ? 'done' : 'active');
    assert.equal(state.requests.find(record => record.id === 'R2').status, 'done');
  }
  const blocker = state => state.blockers.find(record => record.id === 'B1');
  assert.ok(needsAttention(blocker(open)));
  assert.equal(blocker(later).status, 'open');
  assert.equal(blocker(later).attention.state, 'later');
  assert.equal(needsAttention(blocker(later)), false);
  assert.deepEqual(blocker(later).options, blocker(open).options);
  assert.equal(blocker(later).action_url, blocker(open).action_url);
  assert.equal(later.replies[0].items[0].kind, 'defer');
  assert.equal(later.replies[0].items[0].outcome, 'accepted');
  assert.ok(needsAttention(blocker(reopened)));
  assert.equal(blocker(reopened).attention.actor, 'agent');
  assert.match(blocker(reopened).attention.source, /^fictional:dependency:/);
  assert.match(blocker(reopened).attention.reason, /newsletters.*inbox|exported file/);
  assert.equal(blocker(closed).status, 'dismissed');
  assert.match(blocker(closed).dismissal.reason, /exported file/);
  assert.equal(blocker(closed).resolution, undefined);
  assert.equal(closed.decisions[0].user_answer.option_id, 'friday');
  assert.match(closed.decisions[0].user_answer.source, /^fictional:user:/);
  assert.equal(closed.cards.find(card => card.id === 'Q1').status, 'resolved');
  assert.equal(closed.cards.find(card => card.id === 'Q1').resolution.actor, 'user');
  const completions = attentionItems(closed);
  assert.equal(completions.length, 2, 'finished layout and digest remain visible until acknowledged');
  assert.ok(completions.every(({ record }) => record.type === 'completion'));
  assert.deepEqual(completions.map(({ record }) => record.request_id).sort(), ['R1', 'R2']);
  assert.match(closed.requests.find(record => record.id === 'R1').evidence, /Fictional.*selected newsletters.*preview/i);
  assert.match(closed.requests.find(record => record.id === 'R1').evidence, /no email was scheduled or sent/i);
  for (const earlier of [open, later, reopened]) {
    const historical = journalAt(closed, earlier.revision);
    for (const collection of ['requests', 'decisions', 'blockers', 'cards', 'replies']) assert.deepEqual(historical[collection], earlier[collection]);
    assert.deepEqual(closed.history.slice(0, earlier.history.length), earlier.history);
  }
});

test('each fictional moment has a valid stop boundary and completion needs the finished preview', async () => {
  const fixtures = await demoFixtures();
  const endings = { open: 'decision', later: 'decision', reopened: 'blocker', closed: 'complete' };
  for (const [name, state] of Object.entries(fixtures)) {
    assert.equal(state.turn.end_reason, endings[name], name);
    assert.equal(evaluateStop(state, { turnId: state.turn.id }).allowed, true, name);
  }
  assert.equal(fixtures.open.decisions[0].required, true);
  assert.equal(fixtures.later.decisions[0].status, 'open', 'Later on the inbox does not answer the preview decision');
  const unfinished = structuredClone(fixtures.closed);
  unfinished.requests.find(record => record.id === 'R1').status = 'active';
  assert.equal(evaluateCompletion(unfinished, { turnId: unfinished.turn.id }).allowed, false,
    'settled cards alone cannot complete a request whose preview is unfinished');
});

test('public demo hashes browser-normalized bytes and permits only scripts in its sandbox', async () => {
  const { outer, frame, innerSource, document } = await generatedDemo();
  assert.doesNotMatch(innerSource, /\r/, 'Windows CRLF must be normalized before generating CSP hashes');
  assert.equal(outer.querySelectorAll('iframe').length, 1);
  assert.deepEqual(frame.getAttribute('sandbox').trim().split(/\s+/), ['allow-scripts']);
  assert.equal(frame.hasAttribute('src'), false);
  const parentScripts = [...outer.querySelectorAll('script')];
  assert.equal(parentScripts.length, 1);
  assert.equal(parentScripts[0].hasAttribute('src'), false);
  const scripts = [...document.querySelectorAll('script')];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].hasAttribute('src'), false);
  const actualHash = hash(scripts[0].textContent);
  const parent = directives(outer), child = directives(document);
  // srcdoc inherits the parent's policy as well: both must allow these bytes.
  assert.deepEqual(parent.get('script-src'), [actualHash, hash(parentScripts[0].textContent.replace(/\r\n?/g, '\n'))]);
  assert.deepEqual(child.get('script-src'), [actualHash]);
  assert.deepEqual(child.get('style-src'), [hash(document.querySelector('style').textContent)]);
  assert.deepEqual(parent.get('frame-src'), ['about:']);
  assert.deepEqual(child.get('frame-src'), ["'none'"]);
  for (const policy of [parent, child]) {
    assert.deepEqual(policy.get('default-src'), ["'none'"]);
    assert.deepEqual(policy.get('connect-src') ?? policy.get('default-src'), ["'none'"]);
    assert.deepEqual(policy.get('base-uri'), ["'none'"]);
    assert.deepEqual(policy.get('form-action'), ["'none'"]);
  }
  assert.equal(document.querySelectorAll('script[src], link[href], iframe, img[src], video[src], audio[src], form').length, 0);
  for (const element of document.querySelectorAll('*')) for (const attribute of element.attributes) {
    assert.equal(/^on/i.test(attribute.name), false, 'inline event handlers must not bypass script hashing');
  }
});

async function mountDemo(innerSource, postMessage, forbidden, errors) {
  const { document, window: domWindow } = parseHTML(innerSource.replace(/\r\n?/g, '\n'));
  const polls = [];
  const blocked = name => () => { forbidden.push(name); throw new Error(`Demo tried a live capability: ${name}`); };
  const host = new Proxy({}, { get: blocked('host API') });
  const adapter = new Proxy({}, { get: (_, name) => name === 'postMessage' ? postMessage : blocked('unapproved parent access')() });
  // A plain window facade avoids inheriting Node's globals through linkedom.
  const network = { fetch: blocked('fetch'), XMLHttpRequest: blocked('XMLHttpRequest'), WebSocket: blocked('WebSocket'), EventSource: blocked('EventSource') };
  const window = { document, Event: domWindow.Event, crypto: webcrypto, parent: adapter, top: host, openai: host,
    open: blocked('window.open'), navigator: { sendBeacon: blocked('sendBeacon') }, ...network,
    addEventListener: domWindow.addEventListener.bind(domWindow), dispatchEvent: domWindow.dispatchEvent.bind(domWindow) };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: blocked('host storage') });
  const context = vm.createContext({ window, document, structuredClone, URL, crypto: webcrypto,
    ...network,
    openai: host, parent: adapter, top: host, navigator: { sendBeacon: blocked('sendBeacon') },
    setInterval: callback => { polls.push(callback); return polls.length; }, clearInterval() {},
    console: { log() {}, warn: (...values) => errors.push(values), error: (...values) => errors.push(values) },
  });
  vm.runInContext(document.querySelector('script').textContent, context, { timeout: 5_000 });
  await tick();
  window.dispatchEvent(new window.Event('load'));
  await tick();
  return { document, window, polls,
    snapshot() { return structuredClone(vm.runInContext('active', context)); },
    async scenario(name) {
      const selector = document.getElementById('demo-scenario');
      for (const option of selector.querySelectorAll('option')) option.toggleAttribute('selected', option.value === name);
      selector.dispatchEvent(new window.Event('change')); await tick();
    },
  };
}

async function runGeneratedDemo() {
  const { outer, frame } = await generatedDemo();
  const forbidden = [], errors = [], posted = [], listeners = [], childIdentity = {};
  Object.defineProperty(frame, 'contentWindow', { value: childIdentity });
  const receive = (source, data) => { for (const listener of listeners) listener({ source, data }); };
  const parentWindow = { addEventListener(name, callback) { assert.equal(name, 'message'); listeners.push(callback); } };
  vm.runInNewContext(outer.querySelector('script').textContent, { document: outer, window: parentWindow }, { timeout: 5_000 });
  const postMessage = (data, target) => {
    posted.push({ data: structuredClone(data), target });
    receive(childIdentity, data);
  };
  let mounted = await mountDemo(frame.getAttribute('srcdoc'), postMessage, forbidden, errors);
  return {
    get document() { return mounted.document; }, get window() { return mounted.window; }, get polls() { return mounted.polls; },
    forbidden, errors, posted, frame, receive, childIdentity,
    snapshot() { return mounted.snapshot(); },
    async scenario(name) {
      await mounted.scenario(name);
      mounted = await mountDemo(frame.getAttribute('srcdoc'), postMessage, forbidden, errors);
    },
  };
}

test('scenario adapter accepts only allowlisted keys from its own iframe and resets fictional drafts', async () => {
  const demo = await runGeneratedDemo(), initial = demo.frame.getAttribute('srcdoc');
  demo.receive({}, { type: 'request-journal-demo-scenario', scenario: 'closed' });
  assert.equal(demo.frame.getAttribute('srcdoc'), initial);
  for (const data of [null, {}, { type: 'other', scenario: 'closed' }, { type: 'request-journal-demo-scenario', scenario: '__proto__' },
    { type: 'request-journal-demo-scenario', scenario: '<script>bad()</script>' }]) {
    demo.receive(demo.childIdentity, data);
    assert.equal(demo.frame.getAttribute('srcdoc'), initial);
  }
  demo.document.querySelector('#jc-attention [data-record="D1"][data-choice="friday"]').click();
  assert.equal(demo.document.getElementById('jc-send').disabled, false);
  await demo.scenario('later');
  assert.deepEqual(demo.posted, [{ data: { type: 'request-journal-demo-scenario', scenario: 'later' }, target: '*' }]);
  assert.equal(demo.document.querySelector('meta[name="request-journal-demo-scenario"]').getAttribute('content'), 'later');
  assert.equal(demo.document.getElementById('demo-scenario').value, 'later');
  assert.equal(demo.document.getElementById('demo-result').hidden, true);
  await demo.scenario('open');
  assert.equal(demo.document.querySelector('#jc-attention [data-record="D1"][data-choice="friday"]').getAttribute('aria-pressed'), 'false');
  assert.equal(demo.document.getElementById('jc-send').disabled, true);
  assert.equal(demo.document.getElementById('jc-draft').textContent, '');
  assert.deepEqual(demo.forbidden, []);
  assert.deepEqual(demo.errors, []);
});

test('generated renderer uses fictional scenarios and local sample replies without a live host or network', async () => {
  const demo = await runGeneratedDemo(), q = selector => demo.document.querySelector(selector);
  assert.notEqual(q('#jc-goal-status').textContent, 'Done');
  assert.equal(q('#jc-count').textContent, '4');
  assert.match(q('#jc-tree').textContent, /weekly reading digest/);
  q('#jc-attention [data-record="D1"][data-choice="friday"]').click();
  assert.equal(q('#jc-send').disabled, false);
  q('#jc-send').click(); await tick();
  assert.match(q('#demo-reply').textContent, /Which schedule should the digest preview use\?/);
  assert.match(q('#demo-reply').textContent, /Answer: Friday morning/);
  assert.equal(q('#demo-result').hidden, false);
  const storage = demo.window.localStorage;
  assert.equal(typeof storage.key, 'function');
  const pendingKey = Array.from({ length: storage.length }, (_, index) => storage.key(index)).find(key => key.endsWith(':delivery'));
  assert.ok(pendingKey, 'isolated lock adapter must permit staging the frozen sample delivery');
  assert.equal(JSON.parse(storage.getItem(pendingKey)).items[0].option_id, 'friday');
  assert.equal(q('#jc-count').textContent, '4', 'preparing a sample reply does not settle a saved card');
  assert.notEqual(q('#jc-goal-status').textContent, 'Done');
  await demo.scenario('later');
  assert.equal(q('#jc-attention .jc-card[data-record="B1"]'), null);
  assert.ok(q('#jc-cards .jc-card[data-record="B1"]'));
  await demo.scenario('reopened');
  assert.ok(q('#jc-attention .jc-card[data-record="B1"]'));
  await demo.scenario('closed');
  assert.equal(q('#jc-count').textContent, '2', 'completed work keeps its unread notifications');
  assert.equal(q('#jc-goal-status').textContent, 'Done');
  assert.equal(q('#jc-agent-status').textContent, 'Done');
  for (const id of ['D1', 'B1', 'Q1']) assert.ok(q(`#jc-cards .jc-card[data-record="${id}"]`));
  for (const poll of demo.polls) await poll();
  assert.deepEqual(demo.forbidden, []);
  assert.deepEqual(demo.errors, []);
});

test('demo read clicks persist only their card without capturing a reply or losing an unsent Comment', async () => {
  const demo = await runGeneratedDemo(), q = selector => demo.document.querySelector(selector), original = demo.snapshot();
  q('#jc-attention [data-record="B1"] .jc-comment-toggle').click();
  const comment = q('#jc-attention [data-record="B1"] .jc-comment textarea');
  comment.value = 'Keep my unsent fictional comment';
  comment.dispatchEvent(new demo.window.Event('input', { bubbles: true }));
  const read = q('#jc-attention [data-record="Q1"] .jc-read-icon');
  read.click(); await tick();
  assert.equal(q('#jc-attention [data-record="Q1"]'), null);
  assert.equal(q('#demo-result').hidden, true, 'A silent read must not open sample reply capture');
  assert.equal(q('#demo-reply').textContent, '');
  assert.equal(q('#jc-attention [data-record="B1"] .jc-comment textarea').value, 'Keep my unsent fictional comment');
  const saved = demo.snapshot(); validateJournal(saved);
  assert.deepEqual(saved.cards.filter(card => card.id !== 'Q1'), original.cards.filter(card => card.id !== 'Q1'));
  for (const collection of ['requests', 'decisions', 'blockers', 'replies']) assert.deepEqual(saved[collection], original[collection]);
  assert.deepEqual(saved.turn, original.turn);
  assert.equal(saved.revision, original.revision + 1);
  assert.equal(saved.cards.find(card => card.id === 'Q1').status, 'resolved');
  assert.equal(saved.cards.find(card => card.id === 'Q1').resolution.actor, 'user');
  assert.equal(saved.cards.find(card => card.id === 'Q1').resolution.record_revision, 1);
  const earlier = journalAt(saved, original.revision);
  for (const collection of ['requests', 'decisions', 'blockers', 'cards', 'replies']) {
    assert.deepEqual(earlier[collection], original[collection], 'History restores the fictional unread records');
  }
  assert.deepEqual(earlier.turn, original.turn);
  assert.deepEqual(saved.history.slice(0, original.history.length), original.history);
  for (const poll of demo.polls) await poll();
  assert.equal(q('#jc-attention [data-record="Q1"]'), null, 'Refreshing the fake tool keeps its saved read');
  assert.equal(q('#jc-attention [data-record="B1"] .jc-comment textarea').value, 'Keep my unsent fictional comment');
  assert.equal(q('#demo-result').hidden, true);
  assert.deepEqual(demo.snapshot(), saved);
  assert.deepEqual(demo.forbidden, []);
  assert.deepEqual(demo.errors, []);
});
