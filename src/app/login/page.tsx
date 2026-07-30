'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useEffect, useState } from 'react';

export const dynamic = 'force-dynamic';

function getLoginError(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('error') ?? '';
}

export default function LoginPage() {
  const [error, setError] = useState('');
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    setError(getLoginError());
  }, []);

  async function signInWithGoogle() {
    setIsSigningIn(true);
    setError('');

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      setError('Supabase sign-in is not configured yet.');
      setIsSigningIn(false);
      return;
    }

    const supabase = createBrowserClient(url, key);
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: {
          hd: 'automationsystems.org'
        }
      }
    });

    if (signInError) {
      setError('Google sign-in could not be started.');
      setIsSigningIn(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="welcome-panel" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true">
          <i /><i /><i />
        </div>
        <p className="eyebrow">Automation Systems</p>
        <h1 id="login-title">AS CRM</h1>
        <p className="lede">Sign in with your company Google account to continue.</p>
        {error ? (
          <p role="alert" className="login-error">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="login-btn"
          onClick={signInWithGoogle}
          disabled={isSigningIn}
        >
          {isSigningIn ? 'Opening Google…' : 'Continue with Google'}
        </button>
      </section>
    </main>
  );
}
