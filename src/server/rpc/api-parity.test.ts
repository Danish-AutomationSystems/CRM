import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import '../../server/admin/rpc';
import '../../server/cases/rpc';
import '../../server/customers/rpc';
import '../../server/dashboard/rpc';
import '../../server/quotes/rpc';
import { hasRpc, listRegisteredRpcs } from './registry';

const root = process.cwd();

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function appScriptApis(source: string): string[] {
  const matches = source.matchAll(/\bfunction\s+(api_[A-Za-z0-9_]+)\s*\(/g);
  return sortedUnique(Array.from(matches, (match) => match[1]));
}

function uiCalledApis(source: string): string[] {
  const matches = source.matchAll(/\bgs\s*\(\s*(['"])(api_[A-Za-z0-9_]+)\1/g);
  return sortedUnique(Array.from(matches, (match) => match[2]));
}

describe('Apps Script API parity', () => {
  it('keeps every legacy UI-called api_* function registered in the Vercel RPC registry', () => {
    const codeGs = readFileSync(join(root, 'docs/source-appscript/Code.gs'), 'utf8');
    const indexHtml = readFileSync(join(root, 'docs/source-appscript/Index.html'), 'utf8');

    const sourceApis = appScriptApis(codeGs);
    const uiApis = uiCalledApis(indexHtml);
    const registeredApis = listRegisteredRpcs();

    // Capabilities added after the migration that never existed in the
    // legacy Apps Script server - not expected to appear in Code.gs.
    const intentionallyNew = ['api_saveQuotationToDrive'];
    const legacyUiApis = uiApis.filter((api) => !intentionallyNew.includes(api));

    expect(uiApis.length).toBeGreaterThan(0);
    expect(sourceApis).toEqual(expect.arrayContaining(legacyUiApis));
    expect(uiApis.filter((api) => !hasRpc(api))).toEqual([]);
    expect(registeredApis).toEqual(expect.arrayContaining(uiApis));
  });

  it('accounts for every Apps Script api_* server function as either registered or explicitly unmigrated', () => {
    const codeGs = readFileSync(join(root, 'docs/source-appscript/Code.gs'), 'utf8');
    const sourceApis = appScriptApis(codeGs);
    const registeredApis = listRegisteredRpcs();

    const intentionallyUnmigrated: string[] = [];
    const unaccounted = sourceApis.filter(
      (api) => !registeredApis.includes(api) && !intentionallyUnmigrated.includes(api)
    );

    expect(unaccounted).toEqual([]);
  });
});
