'use strict';

// Error output is not reliably JSON: it may be truncated, quoted twice, or a
// multiline header/credential dump. Keep the diagnostic prefix, but suppress
// the entire suffix after a credential marker rather than guessing where an
// arbitrary secret ends. Stage/test identity and exit status live separately.
const SECRET_ASSIGNMENT = /(?<![\w.-])([\w.-]*(?:authorization|cookie|password|passwd|secret|token|credential|signature|api[_-]?key|private[_-]?key|public[_-]?key)[\w.-]*|key)(?:["']|\\["'])*\s*[:=]\s*/i;
// Keep suppression sticky when callers append further stdout/stderr chunks.
const SECRET_LITERAL = /\[REDACTED\]|\b(?:Bearer|Basic)\s+\S+|(?<![\w+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/]*:[^\s/]*@|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

module.exports = value => {
  const text = String(value || '');
  const assignment = SECRET_ASSIGNMENT.exec(text);
  const literal = SECRET_LITERAL.exec(text);
  if (literal && (!assignment || literal.index < assignment.index)) {
    return text.slice(0, literal.index) + '[REDACTED]';
  }
  return assignment
    ? text.slice(0, assignment.index) + assignment[1] + '=[REDACTED]'
    : text;
};
