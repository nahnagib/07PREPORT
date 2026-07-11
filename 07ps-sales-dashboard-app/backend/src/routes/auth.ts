import { Request, Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  AccountUnavailableError,
  InvalidCredentialsError,
  buildMeResponse,
  changePassword,
  forgotPassword,
  login,
  logout,
  resetPassword,
} from '../services/authService';
import { requireAuth } from '../middleware/auth';
import { ValidationError } from '../lib/errors';
import { getUserById } from '../services/userService';

export const authRouter = Router();

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

const loginLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_LOGIN_WINDOW_MIN ?? 15) * 60_000,
  max: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const result = await login(email, password, requestMeta(req));
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err instanceof AccountUnavailableError) {
      res.status(403).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    // requireAuth already verified the token; we still need its exp to size the revoked_tokens
    // row correctly, so re-decode is unnecessary -- issue a revocation valid through the token's
    // natural 1-year lifetime worst case.
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await logout(user.id, user.jti, expiresAt, requestMeta(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user!.id);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const response = await buildMeResponse(user);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'Current and new password are required.' });
      return;
    }
    const result = await changePassword(req.user!.id, currentPassword, newPassword);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

const forgotPasswordLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_LOGIN_WINDOW_MIN ?? 15) * 60_000,
  max: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

authRouter.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }
    await forgotPassword(email);
    // Always the same generic response, whether or not the email matched an account.
    res.json({ ok: true, message: 'If that email exists, a password reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== 'string' || typeof newPassword !== 'string' || !token || !newPassword) {
      res.status(400).json({ error: 'Token and new password are required.' });
      return;
    }
    await resetPassword(token, newPassword);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
