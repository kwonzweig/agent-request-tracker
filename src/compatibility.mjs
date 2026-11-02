// Persisted identifiers from releases before 0.6.3. Keep these stable so an
// upgrade does not strand drafts, retry envelopes or existing journal files.
// They are not product names, skill aliases or installation entry points.
export const legacyDataDirectory = '.request-journal';
export const legacyDataEnvironment = 'REQUEST_JOURNAL_DATA_DIR';
export const uiResourceUri = 'ui://request-journal/tracker.html';
export const replyResourcePrefix = 'request-journal://reply/';
export const replyStoragePrefix = 'request-journal:replies:v1:';
