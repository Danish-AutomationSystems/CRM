'use client';

import React, { useEffect, useRef } from 'react';

import { legacyAppScript, legacyBodyHtml } from './legacy-full.generated';

declare global {
  interface Window {
    BOOT?: { ok: boolean; reason?: string; email?: string };
    __AS_CRM_FETCH__?: typeof fetch;
  }
}

export function LegacyFullCrmApp() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    host.innerHTML = legacyBodyHtml;
    const previousBoot = window.BOOT;
    const fetchImpl = globalThis.fetch
      ? globalThis.fetch.bind(globalThis)
      : window.fetch.bind(window);
    window.BOOT = previousBoot ?? { ok: true };
    window.__AS_CRM_FETCH__ = fetchImpl;

    window.eval(`var BOOT = window.BOOT || { ok: true };\n${legacyAppScript}`);

    return () => {
      host.innerHTML = '';
      window.BOOT = previousBoot;
    };
  }, []);

  return <div ref={hostRef} />;
}
