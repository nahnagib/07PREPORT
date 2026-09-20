/** @type {import('next').NextConfig} */
const nextConfig = {
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
};
export default nextConfig;
