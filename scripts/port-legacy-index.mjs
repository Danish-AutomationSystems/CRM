import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourcePath = path.join(root, 'docs', 'source-appscript', 'Index.html');
const outDir = path.join(root, 'src', 'app', 'crm');

const source = fs.readFileSync(sourcePath, 'utf8');

function between(text, start, end) {
  const a = text.indexOf(start);
  if (a < 0) throw new Error(`Missing marker: ${start}`);
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`Missing marker: ${end}`);
  return text.slice(a + start.length, b);
}

function replaceBetween(text, start, end, replacement) {
  const a = text.indexOf(start);
  if (a < 0) throw new Error(`Missing marker: ${start}`);
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`Missing marker: ${end}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

const fontHref = source.match(/<link\s+href="([^"]*fonts\.googleapis\.com\/css2[^"]*)"\s+rel="stylesheet">/)?.[1];
const css = (fontHref ? `@import url("${fontHref}");\n` : '') + between(source, '<style>', '</style>').trim() + '\n';
let body = between(source, '<body>', '<script>var BOOT = <?!= boot ?>;</script>').trim();
let script = between(source, '<script id="appjs">', '</script>').trim();

body = body.replace('<main id="main"></main>', '<main id="main" data-testid="crm-route" data-route="dash"></main>');
body = body.replace('<button id="qlbtn" ', '<button id="qlbtn" style="display:none" ');
body = body.replace(
  '<nav id="nav">',
  '<button class="nav-toggle" id="navToggle" onclick="document.getElementById(\'nav\').classList.toggle(\'nav-open\');this.setAttribute(\'aria-expanded\',document.getElementById(\'nav\').classList.contains(\'nav-open\'))" aria-label="Toggle navigation" aria-expanded="false">☰</button><nav id="nav" role="navigation" aria-label="Main navigation">'
);

const rpcGs = `var SWR_CACHE = {};
var WRITE_PURGES = {
  saveCustomer: ['getCustomersGrid','getDashboardData','getCustomerDetail'],
  saveCase: ['getCases','getDashboardData','getCustomerDetail'],
  updateContact: ['getCustomerDetail','getCustomersGrid'],
  deleteCustomer: ['getCustomersGrid','getDashboardData'],
  saveQuotation: ['getCases','getDashboardData'],
  purgeCust: ['getCustomersGrid','getDashboardData']
};

function cacheBustKey(fn) {
  if (WRITE_PURGES[fn]) {
    WRITE_PURGES[fn].forEach(function(k) {
      Object.keys(SWR_CACHE).forEach(function(ck) {
        if (ck.indexOf(k) === 0) delete SWR_CACHE[ck];
      });
    });
  } else {
    SWR_CACHE = {};
  }
}

function gs(fn){
  var args = Array.prototype.slice.call(arguments,1);
  var ck = fn + ':' + JSON.stringify(args);
  if (QREADS[fn] && SWR_CACHE[ck] && (Date.now() - SWR_CACHE[ck].ts < 30000)) {
    return Promise.resolve(SWR_CACHE[ck].data);
  }

  busy(true);
  return new Promise(function(res,rej){
    var done=false;
    var timer=setTimeout(function(){ if(done)return; done=true; busy(false); rej(new Error('This is taking longer than usual - tap Retry.')); }, 30000);
    window.__AS_CRM_FETCH__('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    })
      .then(function(response){ return response.json(); })
      .then(function(payload){
        if(done)return;
        done=true;
        clearTimeout(timer);
        busy(false);
        if(!payload || payload.ok===false){ rej(new Error((payload && payload.error) || 'Request failed.')); return; }
        if(QREADS[fn]) { SWR_CACHE[ck] = { ts: Date.now(), data: payload.data }; }
        else { cacheBustKey(fn); }
        res(payload.data);
      })
      .catch(function(e){ if(done)return; done=true; clearTimeout(timer); busy(false); rej(e); });
  });
}
`;

script = replaceBetween(script, 'function gs(fn){', 'var toastT = null;', rpcGs);
script = script.replace(
  'function el(id){ return document.getElementById(id); }',
  `function el(id){ return document.getElementById(id); }
function setRouteAttr(name){ var m=el('main'); if(m) m.setAttribute('data-route', name); }`
);
script = script.replace(
  'function oops(e){ toast(errMsg(e), true); }',
  `function oops(e){
  var msg = errMsg(e);
  if(msg && (msg.indexOf('Cannot set properties of null') > -1 || msg.indexOf("setting 'innerHTML'") > -1 || msg.indexOf("setting 'textContent'") > -1)){ return; }
  toast(msg, true);
}`
);
script = script.replace(
  `function esc(v){
  return String(v===null||v===undefined?'':v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}`,
  `function esc(v){
  return String(v===null||v===undefined?'':v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function jsArg(v){ return esc(JSON.stringify(String(v===null||v===undefined?'':v))); }
function jsJsonArg(v){ return esc(JSON.stringify(v)); }`
);
script = script.replace(/S\.route='([^']+)'/g, "S.route='$1'; setRouteAttr('$1')");

script = script
  .replace(/AS CRM — client app\. Pairs with Code\.gs \(google\.script\.run API\)\./g, 'AS CRM - client app. Pairs with the Next.js RPC server (/api/rpc transport).')
  .replace(/google\.script\.run API/g, '/api/rpc transport')
  .replace(/Apps Script costs ~0\.3-1s per call no matter how\n \* fast the server is/g, 'Network calls still cost time, even with a fast Vercel server')
  .replace(/Google Doc/g, 'CRM document')
  .replace(/Open CRM document/g, 'Download document')
  .replace(/Open PDF/g, 'Download PDF')
  .replace(/Open uploaded file/g, 'Download uploaded file')
  .replace(/Doc \+ PDF/g, 'download')
  .replace(/Document and PDF created\./g, 'Download links created.')
  .replace(/The CRM database has not been created yet\. The administrator must open the Apps Script editor and run setupCRM\(\) once, then reload this page\./g, 'The CRM database has not been created yet. Apply the Supabase migrations and seed the CRM settings, then reload this page.')
  .replace(/No templates found — add a CRM document in the Templates folder/g, 'No templates configured - add templates in Admin settings.')
  .replace(/Open the database sheet \(link below\), paste rows into the <b>Import<\/b> tab/g, 'Paste rows into the Supabase <b>import_customers</b> table')
  .replace(/Paste into the <b>ImportContacts<\/b> tab/g, 'Paste rows into the Supabase <b>import_contacts</b> table')
  .replace(/Processed rows are cleared\./g, 'Processed rows are cleared from the import table.')
  .replace(/The file is stored in the CRM Quotations folder\./g, 'The file is stored in the Supabase database and can be downloaded from this CRM.')
  .replace(/database sheet/g, 'database');

script = script.replace(
  /if\(links\)\{\s*html \+= '<div class="card"><div class="ovl">Drive links[\s\S]*?Generated quotations folder<\/a><\/div><\/div>';\s*\}/,
  `if(links){
    html += '<div class="card"><div class="ovl">Database</div>'+
      '<div class="kv">'+
      '<b>Backend</b><span>'+esc(links.database||'Supabase Postgres')+'</span>'+
      '<b>Project</b><span class="mono">'+esc(links.supabaseUrl||'')+'</span>'+
      '<b>Tables</b><span class="mono">'+esc((links.tables||[]).join(', '))+'</span>'+
      '</div></div>';
  }`
);

script = script.replace(
  `  }).catch(function(e){
    el('hdr').style.display='';
    el('main').innerHTML = '<div class="lockcard"><h1>Could not load</h1><p class="sub" style="margin:12px 0 18px">'+esc(errMsg(e))+'</p><button class="btn" onclick="location.reload()">Reload</button></div>';
  });`,
  `  }).catch(function(e){
    el('hdr').style.display='none';
    BOOT = { ok:false, reason:errMsg(e), email:(BOOT && BOOT.email) || '' };
    window.BOOT = BOOT;
    renderLock();
  });`
);

script = script
  .replace(
    `'<button class="btn" onclick="mNewCustomer(\\''+esc(q).replace(/'/g,"\\\\'")+'\\')">+ Create "'+esc(q)+'"</button></div>';`,
    `'<button class="btn" onclick="mNewCustomer('+jsArg(q)+')">+ Create "'+esc(q)+'"</button></div>';`
  )
  .replace(
    `'<button class="btn ghost sm" onclick=\\'mContact("'+esc(c.id)+'",'+JSON.stringify(ct).replace(/'/g,'&#39;')+')\\'>Edit</button>'+`,
    `'<button class="btn ghost sm" onclick="mContact('+jsArg(c.id)+','+jsJsonArg(ct)+')">Edit</button>'+`
  )
  .replace(
    `S._wk.sug.map(function(o){ return '<button type="button" class="bub" onclick="wkPick(\\''+esc(o.email)+'\\',\\''+esc(String(o.name).replace(/\\\\/g,'').replace(/'/g,''))+'\\')">'+esc(o.name)+'</button>'; }).join('')+'</div>'`,
    `S._wk.sug.map(function(o){ return '<button type="button" class="bub" onclick="wkPick('+jsArg(o.email)+','+jsArg(o.name)+')">'+esc(o.name)+'</button>'; }).join('')+'</div>'`
  )
  .replace(
    `? list.map(function(u){ return '<div class="resrow'+((S._wk.pick&&low(S._wk.pick.email)===low(u.email))?' on':'')+'" onclick="wkPick(\\''+esc(u.email)+'\\',\\''+esc(String(u.name).replace(/\\\\/g,'').replace(/'/g,''))+'\\')"><b>'+esc(u.name)+'</b> <span class="sub">'+esc(u.email)+'</span></div>'; }).join('')`,
    `? list.map(function(u){ return '<div class="resrow'+((S._wk.pick&&low(S._wk.pick.email)===low(u.email))?' on':'')+'" onclick="wkPick('+jsArg(u.email)+','+jsArg(u.name)+')"><b>'+esc(u.name)+'</b> <span class="sub">'+esc(u.email)+'</span></div>'; }).join('')`
  )
  .replace(
    `return '<div class="qr"'+(ok?' onclick="qlPick(\\''+esc(c.id)+'\\',\\''+esc(c.name).replace(/'/g,"\\\\'")+'\\')"':' style="opacity:.55"')+'>'+`,
    `return '<div class="qr"'+(ok?' onclick="qlPick('+jsArg(c.id)+','+jsArg(c.name)+')"':' style="opacity:.55"')+'>'+`
  )
  .replace(
    `'<td><button class="btn ghost sm" onclick=\\'mUser('+JSON.stringify(u).replace(/'/g,'&#39;')+')\\'>Edit</button></td></tr>';`,
    `'<td><button class="btn ghost sm" onclick="mUser('+jsJsonArg(u)+')">Edit</button></td></tr>';`
  )
  .replace(
    `'<td><button class="btn ghost sm" onclick="restoreCust(\\''+esc(c.id)+'\\')">Restore</button> '+`,
    `'<td><button class="btn ghost sm" onclick="restoreCust('+jsArg(c.id)+')">Restore</button> '+`
  )
  .replace(
    `'<button class="btn danger sm" onclick="purgeCust(\\''+esc(c.id)+'\\',\\''+esc(c.name).replace(/'/g,"\\\\'")+'\\')">Delete forever</button></td></tr>';`,
    `'<button class="btn danger sm" onclick="purgeCust('+jsArg(c.id)+','+jsArg(c.name)+')">Delete forever</button></td></tr>';`
  )
  .replace(
    `'<button class="btn danger" onclick="purgeCust2(\\''+esc(id)+'\\')">Delete forever</button>');`,
    `'<button class="btn danger" onclick="purgeCust2('+jsArg(id)+')">Delete forever</button>');`
  );

script = script.replace(/\\''\+esc\(([^)]+)\)\+'\\'/g, "'+jsArg($1)+'");

if (/google\.script\.run|<\?|\?>/.test(script + body)) {
  throw new Error('Generated CRM client still contains Apps Script-only runtime markers.');
}

const generatedTs = `// Generated by scripts/port-legacy-index.mjs from docs/source-appscript/Index.html.
// Keep behavior changes in the generator so this port stays auditable.

export const legacyBodyHtml = ${JSON.stringify(body)};

export const legacyAppScript = ${JSON.stringify(script)};
`;

fs.writeFileSync(path.join(outDir, 'legacy-full.generated.ts'), generatedTs, 'utf8');

// Write baseline CSS for reference/diffing — the actual legacy-full-ui.css
// is now manually maintained for the UI revamp and should NOT be overwritten.
fs.writeFileSync(path.join(outDir, 'legacy-full-ui.baseline.css'), css, 'utf8');

