import nodemailer, { Transporter } from 'nodemailer';

/**
 * Thin wrapper around nodemailer so the rest of the auth module never touches SMTP details
 * directly -- swapping to a transactional provider (SES/SendGrid/etc.) later is a change to this
 * one file only.
 *
 * If SMTP_HOST isn't configured yet (e.g. before an admin has filled in backend/.env), sends are
 * logged instead of thrown -- a user-creation or import flow should never hard-fail just because
 * outbound mail isn't wired up yet, per Section 5.9 (system errors shouldn't cascade into
 * unrelated request failures).
 */
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) {
    transporter = null;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return transporter;
}

async function send(to: string, subject: string, text: string, html: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.warn(`[emailService] SMTP not configured -- would have sent "${subject}" to ${to}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM ?? 'no-reply@example.com', to, subject, text, html });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[emailService] failed to send "${subject}" to ${to}:`, err);
  }
}

export function sendTempPasswordEmail(to: string, fullName: string, tempPassword: string): Promise<void> {
  const subject = 'Your BMH Sales Dashboard account';
  const text =
    `Hello ${fullName},\n\nAn account has been created for you on the BMH Sales Dashboard.\n\n` +
    `Email: ${to}\nTemporary password: ${tempPassword}\n\n` +
    `You will be asked to set a new password the first time you sign in.`;
  const html = `<p>Hello ${fullName},</p><p>An account has been created for you on the BMH Sales Dashboard.</p>
    <p><b>Email:</b> ${to}<br/><b>Temporary password:</b> ${tempPassword}</p>
    <p>You will be asked to set a new password the first time you sign in.</p>`;
  return send(to, subject, text, html);
}

export function sendPasswordResetEmail(to: string, fullName: string, resetUrl: string): Promise<void> {
  const subject = 'Reset your BMH Sales Dashboard password';
  const text =
    `Hello ${fullName},\n\nA password reset was requested for your account. If this was you, ` +
    `use the link below within the next hour:\n\n${resetUrl}\n\n` +
    `If you did not request this, you can ignore this email.`;
  const html = `<p>Hello ${fullName},</p><p>A password reset was requested for your account. If this was you, click below within the next hour:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>If you did not request this, you can ignore this email.</p>`;
  return send(to, subject, text, html);
}
