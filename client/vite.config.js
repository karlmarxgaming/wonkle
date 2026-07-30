import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// Reads the repo-root .env; only the client id is injected into the bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'DISCORD_CLIENT_ID');
  return {
    define: { 'import.meta.env.DISCORD_CLIENT_ID': JSON.stringify(env.DISCORD_CLIENT_ID) },
  };
});
