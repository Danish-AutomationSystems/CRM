#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

export function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function extractCodeGsApis(source) {
  return sortedUnique(Array.from(source.matchAll(/\bfunction\s+(api_[A-Za-z0-9_]+)\s*\(/g), (match) => match[1]));
}

export function extractUiGsCalls(source) {
  return sortedUnique(Array.from(source.matchAll(/\bgs\s*\(\s*(['"])(api_[A-Za-z0-9_]+)\1/g), (match) => match[2]));
}

export function extractRegisteredApis(source) {
  return sortedUnique(
    Array.from(source.matchAll(/\bregisterRpc\s*\(\s*(['"])(api_[A-Za-z0-9_]+)\1/g), (match) => match[2])
  );
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function main() {
  const sourceApis = extractCodeGsApis(read('docs/source-appscript/Code.gs'));
  const uiApis = extractUiGsCalls(read('docs/source-appscript/Index.html'));
  const registeredApis = sortedUnique(
    [
      'src/server/admin/rpc.ts',
      'src/server/cases/rpc.ts',
      'src/server/customers/rpc.ts',
      'src/server/dashboard/rpc.ts',
      'src/server/quotes/rpc.ts'
    ].flatMap((path) => extractRegisteredApis(read(path)))
  );

  const uiMissingInSource = uiApis.filter((api) => !sourceApis.includes(api));
  const uiMissingInRegistry = uiApis.filter((api) => !registeredApis.includes(api));
  const sourceMissingInRegistry = sourceApis.filter((api) => !registeredApis.includes(api));

  if (uiMissingInSource.length || uiMissingInRegistry.length || sourceMissingInRegistry.length) {
    console.error('API parity check failed.');
    if (uiMissingInSource.length) console.error(`UI calls missing in Code.gs: ${uiMissingInSource.join(', ')}`);
    if (uiMissingInRegistry.length) console.error(`UI calls missing in registry: ${uiMissingInRegistry.join(', ')}`);
    if (sourceMissingInRegistry.length) console.error(`Code.gs api_* missing in registry: ${sourceMissingInRegistry.join(', ')}`);
    process.exit(1);
  }

  console.log(`API parity ok: ${uiApis.length} UI calls, ${sourceApis.length} Apps Script APIs, ${registeredApis.length} registered RPCs.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
