'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, TextInput } from '@07ps/ui';
import { AuthLayout } from '../../components/AuthLayout';
import { useAuth } from '../../lib/AuthProvider';
import { ApiError } from '../../lib/api';

/**
 * First-login flow (Standards: "user cannot access ANY other page until the password is
 * changed") and voluntary password changes share this one page. AuthGuard (app/layout.tsx)
 * force-redirects here whenever user.mustChangePassword is true and blocks every other route
 * until this succeeds; once it does, AuthGuard's own effect notices mustChangePassword flipped
 * to false and lets the user continue into the app.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      // AuthGuard only redirects *into* /change-password when mustChangePassword is true; it has
      // no effect that redirects back *out* once this succeeds (whether this was the forced
      // first-login flow or a voluntary change), so this page always sends the user home itself.
      router.push('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title={user?.mustChangePassword ? 'Set a new password' : 'Change password'}
      subtitle={
        user?.mustChangePassword
          ? 'For security, you must set a new password before continuing.'
          : undefined
      }
    >
      <form onSubmit={handleSubmit}>
        <TextInput
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          disabled={submitting}
        />
        <TextInput
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          disabled={submitting}
          helperText="At least 8 characters, including a letter and a number."
        />
        <TextInput
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          disabled={submitting}
        />
        {error && (
          <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: -8, marginBottom: 16 }}>{error}</p>
        )}
        <Button type="submit" fullWidth disabled={submitting}>
          {submitting ? 'Saving...' : 'Save new password'}
        </Button>
      </form>
      {user?.mustChangePassword && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            onClick={() => logout()}
            style={{ border: 'none', background: 'none', color: 'var(--ps-color-muted-text)', fontSize: 12, cursor: 'pointer' }}
          >
            Sign out instead
          </button>
        </div>
      )}
    </AuthLayout>
  );
}
