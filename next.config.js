/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required on Next.js 14 for src/instrumentation.ts's register() hook to
  // actually run (stable without this flag starting in Next 15). Used to
  // boot the scheduled full-catalog trend refresh — see
  // src/lib/fastmossFullRefresh.ts.
  experimental: {
    instrumentationHook: true,
  },
};
module.exports = nextConfig;
