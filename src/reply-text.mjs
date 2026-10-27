const escapeMarkdown = value => String(value).replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, '\\$&');

// Human-readable display only. The accompanying JSON resource binds replies.
export function formatReplyText(items, lookup) {
  return ['## Request Tracker reply', ...items.map(item => {
    const record = lookup(item);
    const title = record?.question ?? record?.title ?? '이전 기록';
    const heading = `### ${escapeMarkdown(title.replace(/[\r\n]+/g, ' '))}`;
    if (['defer', 'acknowledge', 'resolve'].includes(item.kind)) {
      return `${heading}\nAction: ${{ defer: 'Later', acknowledge: 'Acknowledge', resolve: item.collection === 'blockers' ? 'Report completion' : 'Mark as read' }[item.kind]}`;
    }
    const answer = item.text || record?.options?.find(option => option.id === item.option_id)?.label || '선택한 답변';
    const lines = escapeMarkdown(answer).split(/\r?\n/);
    return `${heading}\n${item.kind === 'comment' ? 'Comment' : 'Answer'}: ${lines.join('\n    ')}`;
  })].join('\n\n');
}
