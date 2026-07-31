import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// Reads the repo-root .env. The prefix filter matters: anything listed here is
// baked into a public bundle, so never widen it to the secrets.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), ['DISCORD_CLIENT_ID', 'DEBUG']);
  return {
    define: {
      'import.meta.env.DISCORD_CLIENT_ID': JSON.stringify(env.DISCORD_CLIENT_ID),
      'import.meta.env.DEBUG': JSON.stringify(env.DEBUG ?? ''),
    },
  };
});
