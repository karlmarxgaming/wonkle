import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, GUILD_ID, PORT = 3001 } = process.env;

let puzzle = null;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

async function buildPuzzle() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const authors = new Map();
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (channel?.type !== ChannelType.GuildText) continue;
    const perms = channel.permissionsFor(guild.members.me);
    if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
    const messages = await channel.messages.fetch({ limit: 100 });
    for (const msg of messages.values()) {
      if (msg.author.bot || msg.content.length < 100) continue;
      if (msg.attachments.size || msg.embeds.length) continue;
      if (/https?:\/\//i.test(msg.content)) continue;
      if (msg.mentions.users.size || msg.mentions.roles.size || msg.mentions.channels.size || msg.mentions.everyone) continue;
      const author = authors.get(msg.author.id) ?? {
        name: msg.member?.displayName ?? msg.author.displayName,
        texts: [],
      };
      author.texts.push(msg.content);
      authors.set(msg.author.id, author);
    }
  }
  const pool = shuffle([...authors.entries()]);
  if (pool.length < 5) throw new Error(`need eligible messages from 5+ distinct authors, found ${pool.length}`);
  const chosen = pool.slice(0, 5);
  // Red herrings are other authors seen in the scan: listing arbitrary guild
  // members would require the privileged GuildMembers intent.
  const herrings = pool.slice(5, 8);
  puzzle = {
    messages: chosen.map(([id, a]) => ({
      text: a.texts[Math.floor(Math.random() * a.texts.length)],
      authorId: id,
    })),
    options: shuffle([...chosen, ...herrings].map(([id, a]) => ({ id, name: a.name }))),
  };
}

client.once(Events.ClientReady, async () => {
  console.log(`logged in as ${client.user.tag}`);
  try {
    await buildPuzzle();
    console.log(`puzzle ready: ${puzzle.messages.length} messages, ${puzzle.options.length} options`);
  } catch (err) {
    console.error('failed to build puzzle:', err);
  }
});

const app = express();
app.use(express.json());

app.post('/api/token', async (req, res) => {
  const r = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: req.body.code ?? '',
    }),
  });
  if (!r.ok) {
    console.error('token exchange failed:', r.status, await r.text());
    return res.status(500).json({ error: 'token exchange failed' });
  }
  const { access_token } = await r.json();
  res.json({ access_token });
});

app.get('/api/puzzle', (req, res) => {
  if (!puzzle) return res.status(503).json({ error: 'puzzle not ready' });
  res.json({ messages: puzzle.messages.map((m) => m.text), options: puzzle.options });
});

app.post('/api/guess', (req, res) => {
  if (!puzzle) return res.status(503).json({ error: 'puzzle not ready' });
  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length !== puzzle.messages.length) {
    return res.status(400).json({ error: `expected ${puzzle.messages.length} answers` });
  }
  const correct = puzzle.messages.map((m) => m.authorId);
  const score = correct.filter((id, i) => answers[i] === id).length;
  res.json({ score, correct });
});

app.use(express.static(fileURLToPath(new URL('../client/dist', import.meta.url))));

app.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
client.login(DISCORD_BOT_TOKEN);
