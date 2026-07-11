'use client';
import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, TextInput } from '@07ps/ui';
import { AuthLayout } from '../../components/AuthLayout';
import { resetPassword, ApiError } from '../../lib/api';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <p style={{ fontSize: 14, color: 'var(--ps-color-alert)' }}>
        This reset link is missing its token. Request a new one from the{' '}
        <Link href="/forgot-password" style={{ color: 'var(--ps-color-accent)' }}>
          Forgot password
        </Link>{' '}
        page.
      </p>
    );
  }

  if (done) {
    return (
      <div>
        <p style={{ fontSize: 14, color: 'var(--ps-color-text)' }}>
          Your password has been reset. You can now sign in with your new password.
        </p>
        <Link href="/login" style={{ fontSize: 13, color: 'var(--ps-color-accent)' }}>
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
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
        {submitting ? 'Saving...' : 'Reset password'}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout title="Reset password">
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </AuthLayout>
  );
}
