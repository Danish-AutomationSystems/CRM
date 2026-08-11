// Pure helpers for scripts/port-legacy-index.mjs's `el(x).innerHTML = EXPR;`
// -> `setHtml(x, EXPR)` / `el(x).textContent = EXPR;` -> `setText(x, EXPR)`
// rewrite.
//
// The historical bug: a naive scanner stopped at the FIRST `;` character,
// which breaks whenever EXPR contains a `;` inside a string literal (CSS
// strings like 'width:100%;height:auto'), a template literal, a nested
// function/callback body, or a comment. `findStatementEnd` below tracks
// string/template/regex/comment state and bracket-nesting depth so it only
// stops at a `;` that is a real, top-level statement terminator.

const REGEX_CONTEXT_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await'
]);

/**
 * Decide whether a `/` at index `i` in `text` starts a regex literal (true)
 * or is a division operator (false), by looking at the previous meaningful
 * token.
 */
function isRegexContext(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const c = text[j];
  if (c === ')' || c === ']') return false;
  if (c === '"' || c === "'" || c === '`') return false;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
    const word = text.slice(k + 1, j + 1);
    if (/^[0-9]/.test(word)) return false; // number literal -> division
    return REGEX_CONTEXT_KEYWORDS.has(word);
  }
  // operator/punctuation before the slash -> regex literal
  return true;
}

/** Skip a single/double-quoted string literal starting at `text[i]` (the opening quote). Returns index just past the closing quote. */
function skipQuotedString(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) { i++; break; }
    i++;
  }
  return i;
}

/** Skip a template literal starting at `text[i]` (the opening backtick), honoring `${...}` interpolation. Returns index just past the closing backtick. */
function skipTemplateLiteral(text, i) {
  i++; // past opening `
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') { i++; break; }
    if (text[i] === '$' && text[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '{') { depth++; i++; continue; }
        if (c === '}') { depth--; i++; continue; }
        if (c === '"' || c === "'") { i = skipQuotedString(text, i); continue; }
        if (c === '`') { i = skipTemplateLiteral(text, i); continue; }
        if (c === '/' && text[i + 1] === '/') {
          const nl = text.indexOf('\n', i);
          i = nl === -1 ? text.length : nl;
          continue;
        }
        if (c === '/' && text[i + 1] === '*') {
          const end = text.indexOf('*/', i + 2);
          i = end === -1 ? text.length : end + 2;
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/** Skip a regex literal starting at `text[i]` (the opening `/`). Returns index just past the trailing flags. */
function skipRegexLiteral(text, i) {
  i++; // past opening /
  let inClass = false;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '[') { inClass = true; i++; continue; }
    if (text[i] === ']') { inClass = false; i++; continue; }
    if (text[i] === '/' && !inClass) { i++; break; }
    if (text[i] === '\n') break; // unterminated - bail without consuming the newline
    i++;
  }
  while (i < text.length && /[a-zA-Z]/.test(text[i])) i++;
  return i;
}

/**
 * Find the index of the `;` that terminates the statement whose expression
 * begins at `start` in `text`. Tracks string/template/regex literals, line
 * and block comments, and `(`/`[`/`{` nesting depth so a `;` inside any of
 * those is never mistaken for the terminator. Returns -1 if none is found
 * (unterminated statement - the caller should treat this as an error).
 */
export function findStatementEnd(text, start) {
  let i = start;
  let depth = 0;

  while (i < text.length) {
    const c = text[i];

    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }

    if (c === '"' || c === "'") { i = skipQuotedString(text, i); continue; }
    if (c === '`') { i = skipTemplateLiteral(text, i); continue; }

    if (c === '/' && isRegexContext(text, i)) { i = skipRegexLiteral(text, i); continue; }

    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }

    if (c === ';' && depth === 0) return i;

    i++;
  }

  return -1;
}

const DOM_ASSIGNMENT_PATTERN = /el\(([^()]+)\)\.(innerHTML|textContent)\s*=(?!=)\s*/g;

/**
 * Rewrite every top-level `el(x).innerHTML = EXPR;` to `setHtml(x, EXPR);`
 * and `el(x).textContent = EXPR;` to `setText(x, EXPR);` in `script`, using
 * `findStatementEnd` to correctly locate each EXPR's true terminating `;`
 * regardless of strings, template literals, regexes, comments, or nested
 * callback bodies inside EXPR.
 */
export function rewriteDomAssignments(script) {
  let result = '';
  let cursor = 0;
  DOM_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match;

  while ((match = DOM_ASSIGNMENT_PATTERN.exec(script))) {
    const matchStart = match.index;
    const exprStart = DOM_ASSIGNMENT_PATTERN.lastIndex;
    const target = match[1];
    const prop = match[2];
    const helper = prop === 'innerHTML' ? 'setHtml' : 'setText';

    const semiIndex = findStatementEnd(script, exprStart);
    if (semiIndex === -1) {
      throw new Error(
        `Could not find terminating ';' for ${prop} assignment near offset ${matchStart} while rewriting DOM assignments.`
      );
    }

    const expr = script.slice(exprStart, semiIndex);
    result += script.slice(cursor, matchStart) + `${helper}(${target}, ${expr})`;
    cursor = semiIndex; // leave the ';' itself in place
    DOM_ASSIGNMENT_PATTERN.lastIndex = cursor;
  }

  result += script.slice(cursor);
  return result;
}
