/** Must match `basePath` in frontend/next.config.mjs. */
export const FRONTEND_BASE_PATH = '/Dashboard';

/**
 * Public URL of the web app (including the /Dashboard base path), for links that leave the app --
 * e.g. the Kaizen Board QR code printed on the physical board. PUBLIC_APP_URL wins when set (use it
 * in production, e.g. https://bmh.com.ly/Dashboard); otherwise the first FRONTEND_ORIGIN entry +
 * the base path, which is what local development already configures.
 */
export function publicAppUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const origin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',')[0].trim().replace(/\/+$/, '');
  return `${origin}${FRONTEND_BASE_PATH}`;
}
