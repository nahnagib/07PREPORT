'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Button, TextInput } from '@07ps/ui';
import { AuthLayout } from '../../components/AuthLayout';
import { forgotPassword, ApiError } from '../../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Backend always returns the same generic response regardless of whether the email exists
      // (Standards Section 5.9 -- never reveal account existence via a self-service endpoint).
      await forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Forgot password" subtitle="We'll email you a link to reset it.">
      {sent ? (
        <p style={{ fontSize: 14, color: 'var(--ps-color-text)' }}>
          If that email exists in our system, a password reset link has been sent. Check your inbox.
        </p>
      ) : (
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
          {error && (
            <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: -8, marginBottom: 16 }}>{error}</p>
          )}
          <Button type="submit" fullWidth disabled={submitting}>
            {submitting ? 'Sending...' : 'Send reset link'}
          </Button>
        </form>
      )}
      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <Link href="/login" style={{ fontSize: 13, color: 'var(--ps-color-accent)' }}>
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
