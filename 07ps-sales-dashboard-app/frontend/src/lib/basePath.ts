/**
 * Must match `basePath` in frontend/next.config.mjs -- the app is reverse-proxied at
 * bmh.com.ly/Dashboard/*. next/link and useRouter() navigation auto-prefix routes with this, but
 * static assets referenced by a raw string src (next/image, <img>) are NOT auto-prefixed by
 * Next.js, so any local asset path (e.g. the header/login logos under public/logos) must be
 * prefixed with this constant or it 404s under the real deployment while still working in local
 * dev (where there's no basePath-restricted proxy in front of it).
 */
export const BASE_PATH = '/Dashboard';
