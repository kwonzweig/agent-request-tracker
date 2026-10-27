import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { build } from 'esbuild';

export const tick = () => new Promise(resolve => setImmediate(resolve));
export function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    key: index => [...values.keys()][index] ?? null, get length() { return values.size; }, values };
}
const lockQueues = new Map();
export const testLocks = { request(name, options, callback) {
  const previous = lockQueues.get(name) ?? Promise.resolve();
  const pending = previous.then(callback);
  lockQueues.set(name, pending.catch(() => {}));
  return pending;
} };
export const mockHostPlugin = {
  name: 'host-test-double',
  setup(builder) {
    builder.onResolve({ filter: /^@/ }, args => ({ path: args.path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path.includes('mcp-extensions') ?
      'export const OpenAIExtensions = globalThis.TestExtensions;' :
      'export const App = globalThis.TestApp; export const applyDocumentTheme = globalThis.TestTheme; export const applyHostStyleVariables = globalThis.TestStyles;' }));
  },
};
export async function view({ canSend = true, storage = memoryStorage(), sendImpl, toolImpl, hostContext = { theme: 'dark' } } = {}) {
  const { window, document } = parseHTML(await readFile('src/app.html', 'utf8'));
  window.localStorage = storage;
  const sent = [], toolCalls = [], themes = [], styles = [];
  let app, refresh, reply;
  class App {
    constructor() { app = this; }
    async connect() {}
    getHostContext() { return hostContext; }
    async callServerTool(request) {
      toolCalls.push(structuredClone(request));
      return toolImpl ? toolImpl(structuredClone(request), reply) : reply;
    }
  }
  class OpenAIExtensions {
    constructor() { if (canSend) this.message = { send: async message => { sent.push(message); return sendImpl?.(message); } }; }
  }
  const compiled = await build({ entryPoints: ['src/app.mjs'], bundle: true, format: 'iife', write: false, plugins: [mockHostPlugin] });
  vm.runInNewContext(compiled.outputFiles[0].text, { window, document, TestApp: App, TestExtensions: OpenAIExtensions,
    TestTheme: theme => themes.push(theme), TestStyles: value => styles.push(value), structuredClone, crypto: webcrypto, URL, navigator: { locks: testLocks },
    setInterval: fn => { refresh = fn; return 1; }, clearInterval() {}, console });
  await tick();
  return { window, document, sent, toolCalls, themes, styles, storage,
    show(state) { reply = { structuredContent: { journal: state } }; app.ontoolresult(reply); },
    setRead(state) { reply = { structuredContent: { journal: state } }; },
    async refresh(state) { reply = { structuredContent: { journal: state } }; await refresh(); },
    theme(context) { app.onhostcontextchanged(context); },
    envelope() { return JSON.parse(sent.at(-1).content.find(block => block.type === 'resource').resource.text); },
  };
}

export function commit(previous, updates = {}, turnId = `T${previous.revision + 1}`) {
  const state = structuredClone(previous), changes = [];
  for (const collection of ['requests', 'decisions', 'blockers', 'cards', 'replies']) for (const record of updates[collection] || []) {
    state[collection] ??= [];
    const index = state[collection].findIndex(old => old.id === record.id), before = index < 0 ? null : state[collection][index];
    if (index < 0) state[collection].push(structuredClone(record)); else state[collection][index] = structuredClone(record);
    changes.push({ collection, id: record.id, before, after: structuredClone(record) });
  }
  const turn = { id: turnId, summary: `요청 기록 ${previous.revision + 1}`, source: `user:${previous.revision + 1}`, end_reason: null, ...updates.turn };
  changes.push({ collection: 'turn', id: turn.id, before: state.turn, after: turn });
  state.turn = turn; state.revision++;
  state.history.push({ revision: state.revision, turn_id: turnId, changes });
  return state;
}
export function markReadState(journal, { card_id, record_revision }) {
  const saved = structuredClone(journal), index = saved.cards.findIndex(card => card.id === card_id), before = saved.cards[index];
  const after = { ...before, status: 'resolved', resolution: { actor: 'user',
    source: `app:journal_mark_read:${card_id}:${record_revision}`, note: 'Marked as read in Request Tracker.', record_revision } };
  saved.cards[index] = after; saved.revision++;
  saved.history.push({ revision: saved.revision, turn_id: saved.turn.id, changes: [{ collection: 'cards', id: card_id, before, after }] });
  return saved;
}
export function state() {
  return commit({ schema_version: 1, conversation_id: 'C1', revision: 0, requests: [], decisions: [], blockers: [], cards: [], replies: [], turn: null, history: [] }, {
    requests: [{ id: 'R1', parent_id: null, title: '원래 요청', status: 'active', done_when: '실제 동작 확인', source: 'user:1', scope: '원래 범위' }],
    decisions: [{ id: 'D1', request_id: 'R1', revision: 1, question: '어디에 표시할까요?', why: '사용할 화면을 정합니다.', source: 'assistant:1',
      options: [{ id: 'A', label: '채팅 카드', impact: '같은 대화에서 봅니다.' }, { id: 'B', label: '별도 화면', impact: '따로 열어 봅니다.' }],
      recommendation: 'A', no_answer_behavior: '답변을 기다립니다.', status: 'open' }],
  });
}
export function previewState() {
  let journal = state();
  journal = commit(journal, { requests: [{ id: 'R2', parent_id: 'R1', title: '모바일 화면', status: 'done', done_when: '작은 화면에서 정상 표시', evidence: '폭 320px 확인', source: 'user:2' }],
    cards: [{ id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: '표시 범위', body: '현재 대화의 요청과 답변을 기록합니다.', status: 'resolved', source: 'assistant:2' }] });
  return commit(journal, {
    turn: { summary: '모바일 화면을 확인했습니다. 표시 위치를 선택하고 연결 상태를 확인해 주세요.', end_reason: 'decision' },
    blockers: [{ id: 'B1', request_id: 'R1', title: '메일 연결을 확인해 주세요', evidence: '인증이 만료돼 연결 확인이 멈췄습니다.', next_action: '연결 페이지 열기', owner: 'user', status: 'open', action_url: 'https://example.com' }],
    cards: [{ id: 'S1', request_id: 'R1', revision: 1, type: 'suggestion', title: 'FAQ도 추가하면 어떨까요?', body: '반복 문의를 줄일 수 있습니다. 현재 작업에는 포함되지 않습니다.', status: 'open', source: 'assistant:3', options: [{ id: 'later', label: '나중에 검토', impact: '현재 범위는 유지합니다.' }, { id: 'decline', label: '제외', impact: '제안을 제외합니다.' }] },
      { id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: '모바일 화면도 확인했나요?', body: '네. 작은 화면에서도 문구와 버튼이 잘리지 않는지 확인했습니다.', status: 'answered', source: 'assistant:3' },
      { id: 'N1', request_id: 'R1', revision: 2, type: 'note', title: '표시 범위', body: '현재 대화의 요청과 답변을 기록합니다.', status: 'resolved', source: 'assistant:3' }],
  });
}
