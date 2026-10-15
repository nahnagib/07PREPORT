import { existsSync, readFileSync } from 'node:fs';

// A dev server may inherit an API address from an older launcher. Use this workspace's
// explicit local setting for the client bundle so the UI and policy API stay together.
const localEnvFile = new URL('./.env.local', import.meta.url);
const localApi = process.env.NODE_ENV === 'development' && existsSync(localEnvFile)
  ? readFileSync(localEnvFile, 'utf8').match(/^NEXT_PUBLIC_API_BASE_URL\s*=\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '')
  : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: localApi ? { NEXT_PUBLIC_API_BASE_URL: localApi } : {},
  transpilePackages: ['@07ps/ui'],
  reactStrictMode: true,
  // Company routing plan: this app is mounted at bmh.com.ly/Dashboard/* behind a reverse proxy.
  // next/link and useRouter() navigation auto-prefix with this, so route code stays basePath-free.
  basePath: '/Dashboard',
  eslint: {
    // Disable ESLint during build - will be checked separately if needed. (Merged in from a
    // duplicate next.config.js that had accumulated this setting on its own -- Next.js only
    // loads one config file, and that stray .js file was silently shadowing this .mjs file's
    // `basePath`, which is what broke every logo/static-asset URL. Keep all Next config here.)
    ignoreDuringBuilds: true,
  },
  // Renamed reports: old links and bookmarks keep working (basePath is added to both sides automatically).
  async redirects() {
    return [{ source: '/price/debt-report', destination: '/price/receivables-collections', permanent: false }];
  },
};
export default nextConfig;
