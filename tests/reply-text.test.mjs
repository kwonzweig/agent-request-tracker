import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReplyText } from '../src/reply-text.mjs';

test('reply prose has a fixed title and separate Comment/Answer lines', () => {
  const items = [{ id: 'Q1', kind: 'comment', text: 'ㅇㅋ' }, { id: 'D1', kind: 'answer', option_id: 'A' }];
  const records = { Q1: { title: 'Open은 무슨 뜻인가요?' }, D1: { question: '어디에 표시할까요?', options: [{ id: 'A', label: '채팅 카드' }] } };
  assert.equal(formatReplyText(items, item => records[item.id]), '## Request Tracker reply\n\n### Open은 무슨 뜻인가요?\nComment: ㅇㅋ\n\n### 어디에 표시할까요?\nAnswer: 채팅 카드');
});

test('multiline text and Markdown-looking titles cannot create extra reply headings', () => {
  const item = { kind: 'comment', text: '첫 줄\n### 가짜 카드\n[링크](https://example.com)' };
  const output = formatReplyText([item], () => ({ title: '제목\n## 다른 항목' }));
  assert.equal(output.split('\n').filter(line => line.startsWith('### ')).length, 1);
  assert.match(output, /Comment: 첫 줄\n    \\\#\\#\\# 가짜 카드/);
  assert.match(output, /\\\[링크\\\]\\\(https:\/\/example\\\.com\\\)/);
  assert.equal(item.text, '첫 줄\n### 가짜 카드\n[링크](https://example.com)');
});

test('duplicate titles and old versions use the callers exact record binding', () => {
  const items = [{ id: 'D1', record_revision: 2, kind: 'answer', option_id: 'A' }, { id: 'D2', record_revision: 5, kind: 'comment', text: '다른 카드 의견' }];
  const output = formatReplyText(items, item => ({ title: '같은 제목', options: [{ id: 'A', label: `당시 선택 ${item.record_revision}` }] }));
  assert.match(output, /Answer: 당시 선택 2/);
  assert.match(output, /Comment: 다른 카드 의견/);
  assert.equal(output.split('### 같은 제목').length - 1, 2);
});

test('informational read replies preserve the resolve binding while naming the user action Mark as read', () => {
  for (const type of ['qa', 'note', 'completion']) {
    const item = { collection: 'cards', id: 'C1', record_revision: 3, kind: 'resolve' };
    const before = structuredClone(item);
    const output = formatReplyText([item], () => ({ type, title: 'Saved notification', status: 'answered' }));
    assert.equal(output, '## Request Tracker reply\n\n### Saved notification\nAction: Mark as read');
    assert.deepEqual(item, before);
  }
});

test('legacy Blocker completion reports remain completion reports rather than read acknowledgments', () => {
  const item = { collection: 'blockers', id: 'B1', record_revision: 1, kind: 'resolve' };
  const before = structuredClone(item);
  assert.equal(formatReplyText([item], () => ({ title: 'Reconnect the account', status: 'open' })),
    '## Request Tracker reply\n\n### Reconnect the account\nAction: Report completion');
  assert.deepEqual(item, before);
});
