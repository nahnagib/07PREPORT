'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Button, TextInput } from '@07ps/ui';
import { AuthLayout } from '../../components/AuthLayout';
import { useAuth } from '../../lib/AuthProvider';
import { ApiError } from '../../lib/api';

/**
 * Real login screen -- replaces the dev-only role switcher that used to live on the Tachometer
 * page (see AuthProvider.tsx's header). No self-service registration exists (Standards: accounts
 * are Admin-created or Excel-imported only); this page's only job is email+password -> session.
 */
export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // AuthGuard (app/layout.tsx) handles the post-login redirect (home, or /change-password if
      // mustChangePassword) once the session state updates -- no explicit router.push needed here.
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="BMH Sales Dashboard">
      <form onSubmit={handleSubmit}>
        <TextInput
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={submitting}
        />
        <TextInput
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={submitting}
        />
        {error && (
          <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: -8, marginBottom: 16 }}>{error}</p>
        )}
        <Button type="submit" fullWidth disabled={submitting}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <Link href="/forgot-password" style={{ fontSize: 13, color: 'var(--ps-color-accent)' }}>
          Forgot your password?
        </Link>
      </div>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', textAlign: 'center', marginTop: 20, marginBottom: 0 }}>
        Accounts are created by an administrator. There is no self-service registration.
      </p>
    </AuthLayout>
  );
}
