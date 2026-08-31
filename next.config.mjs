/** @type {import('next').NextConfig} */
const nextConfig = {
  // Scope hoisting is on by default in production Turbopack builds.
  // Flip this to `false` to see the merged-group count drop to zero:
  // experimental: {
  //   turbopackScopeHoisting: false,
  // },
};

export default nextConfig;
