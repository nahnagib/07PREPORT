/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@07ps/ui'],
  reactStrictMode: true,
  // Company routing plan: this app is mounted at bmh.com.ly/Dashboard/* behind a reverse proxy.
  // next/link and useRouter() navigation auto-prefix with this, so route code stays basePath-free.
  basePath: '/Dashboard',
};
export default nextConfig;
