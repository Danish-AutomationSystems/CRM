import { describe, expect, test } from 'vitest';

import { findStatementEnd, rewriteDomAssignments } from './dom-assignment-transform.mjs';

describe('findStatementEnd', () => {
  test('finds the terminator after a plain expression', () => {
    const text = "foo = 1; bar();";
    const start = text.indexOf('1');
    expect(findStatementEnd(text, start)).toBe(text.indexOf(';'));
  });

  test('skips a ; inside a single-quoted CSS string', () => {
    const text = "x = 'width:100%;height:auto'; next();";
    const start = text.indexOf("'width");
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    expect(text.slice(start, end)).toBe("'width:100%;height:auto'");
  });

  test('skips a ; inside a template literal, including interpolation', () => {
    const text = "x = `a;b${c ? 'd;e' : 1};f`; next();";
    const start = text.indexOf('`a');
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    expect(text.slice(start, end)).toBe("`a;b${c ? 'd;e' : 1};f`");
  });

  test('skips ; statements inside a nested arrow-function callback body', () => {
    const text = "x = items.map(c => { var y = 1; return y; }).join(''); next();";
    const start = text.indexOf('items');
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    expect(text.slice(start, end)).toBe("items.map(c => { var y = 1; return y; }).join('')");
  });

  test('skips ; statements inside a nested function-expression callback body', () => {
    const text = "x = items.map(function(c){ var y = 1; return y; }).join(''); next();";
    const start = text.indexOf('items');
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    expect(text.slice(start, end)).toBe("items.map(function(c){ var y = 1; return y; }).join('')");
  });

  test('skips a ; inside a // line comment', () => {
    const text = "x = 1 // this; has; semicolons\n; next();";
    const start = text.indexOf('1');
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    // The terminator is the one AFTER the comment/newline, not inside it.
    expect(end).toBe(text.indexOf(';', text.indexOf('\n')));
  });

  test('skips a ; inside a /* block */ comment', () => {
    const text = "x = 1 /* a; b; c */; next();";
    const start = text.indexOf('1');
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    expect(text.slice(start, end)).toBe("1 /* a; b; c */");
  });

  test('treats a regex literal containing a ; as opaque', () => {
    const text = "x = /a;b/.test(y); next();";
    const start = text.indexOf('/a');
    const end = findStatementEnd(text, start);
    expect(text[end]).toBe(';');
    expect(text.slice(start, end)).toBe("/a;b/.test(y)");
  });

  test('does not confuse a division for a regex literal', () => {
    const text = "x = a / b; next();";
    const start = text.indexOf('a / b');
    const end = findStatementEnd(text, start);
    expect(end).toBe(text.indexOf(';'));
  });
});

describe('rewriteDomAssignments', () => {
  test('rewrites a simple innerHTML assignment', () => {
    const out = rewriteDomAssignments("el('mbody').innerHTML = html; next();");
    expect(out).toBe("setHtml('mbody', html); next();");
  });

  test('rewrites a simple textContent assignment', () => {
    const out = rewriteDomAssignments("el('mtitle').textContent = title; next();");
    expect(out).toBe("setText('mtitle', title); next();");
  });

  test('rewrites an innerHTML assignment whose expression contains a ; inside a string', () => {
    const out = rewriteDomAssignments(
      "el('x').innerHTML = '<div style=\"width:100%;height:auto\"></div>'; next();"
    );
    expect(out).toBe(
      "setHtml('x', '<div style=\"width:100%;height:auto\"></div>'); next();"
    );
  });

  test('rewrites an innerHTML assignment whose expression contains a nested callback body', () => {
    const out = rewriteDomAssignments(
      "el('pc_res').innerHTML = full.map(function(c){ return '<div>'+esc(c.name)+'</div>'; }).join(''); next();"
    );
    expect(out).toBe(
      "setHtml('pc_res', full.map(function(c){ return '<div>'+esc(c.name)+'</div>'; }).join('')); next();"
    );
  });

  test('rewrites multiple assignments in one script, each independently', () => {
    const out = rewriteDomAssignments(
      "el('a').innerHTML = 'x;y'; el('b').textContent = 'p;q'; done();"
    );
    expect(out).toBe("setHtml('a', 'x;y'); setText('b', 'p;q'); done();");
  });

  test('leaves everything but the target statements untouched', () => {
    const out = rewriteDomAssignments("var q = 1; foo();");
    expect(out).toBe("var q = 1; foo();");
  });

  test('produces syntactically valid JavaScript for a realistic multi-statement snippet', () => {
    const src = `
function render(list){
  el('pc_res').style.display='block';
  el('pc_res').innerHTML = list.map(function(c){
    return '<div class="qr" onclick="closeModal();mNewCase(\\''+esc(c.id)+'\\')">'+esc(c.name)+'</div>';
  }).join('');
}
`;
    const out = rewriteDomAssignments(src);
    expect(() => new Function(out)).not.toThrow();
    expect(out).toContain("setHtml('pc_res', list.map(");
  });
});
