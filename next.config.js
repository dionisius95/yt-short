/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export for Electron compatibility — output goes to renderer/out
  output: 'export',

  // Disable image optimization (not available in static export)
  images: {
    unoptimized: true,
  },

  // Disable server-side features not available in Electron
  trailingSlash: true,

  // Custom webpack configuration for Electron compatibility
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Prevent bundling of Node.js built-ins in the renderer
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        buffer: false,
        child_process: false,
        net: false,
        tls: false,
      };
    }

    // Exclude native modules from webpack bundling
    config.externals = [
      ...(config.externals || []),
      'better-sqlite3',
      'keytar',
      '@mediapipe/tasks-vision',
    ];

    return config;
  },

  // TypeScript config for renderer
  typescript: {
    tsconfigPath: './tsconfig.renderer.json',
  },
};

module.exports = nextConfig;
