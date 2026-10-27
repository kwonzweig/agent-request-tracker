// Host adapters, file paths and records share one identifier contract.
export const isJournalId = value => typeof value === 'string' &&
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9_-]|[A-Za-z0-9])$/.test(value) && !value.includes('..');
