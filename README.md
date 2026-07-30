# Wonkle

Discord Activity demo: the bot samples 5 long messages from your server, players guess who wrote each one. Guesses are locked in one at a time; grading happens server-side.

- `server/` — express + discord.js in a single process. Builds the puzzle on startup (stand-in for a daily cron) and serves the API + static frontend.
- `client/` — vanilla JS + `@discord/embedded-app-sdk`. Bundled with vite only because the SDK ships with bare npm dependencies and can't be loaded directly by a browser.

## Discord app setup

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **OAuth2**: copy the Client ID and Client Secret. Add any redirect URI (e.g. `https://127.0.0.1` — required for `authorize()` to work, the value itself is unused by the activity flow).
3. **Bot**: reset/copy the token. Under *Privileged Gateway Intents* enable **Message Content Intent**.
4. Invite the bot: OAuth2 URL Generator → scope `bot` → permissions *View Channels* + *Read Message History* → open the generated URL and pick your server.
5. **Activities** (left sidebar): enable Activities. Under *URL Mappings* set the root mapping `/` to your public HTTPS URL (see below).

## Run locally

```sh
npm install
cp .env.example .env    # fill in the values from the steps above
npm run build
npm start
```

Expose the server over HTTPS, e.g. `cloudflared tunnel --url http://localhost:3001` (or ngrok), and put that URL in the activity's root URL mapping.

To launch: in your server, join a voice channel → Activities (rocket icon) → pick your app. Unreleased activities are only visible to the app's own developers.

Note: the answer pool's red herrings are other message authors found in the channel scan — listing arbitrary guild members would require the privileged Guild Members intent.
