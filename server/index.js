import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, GUILD_ID, PORT = 3001 } = process.env;

const db = new Database(fileURLToPath(new URL('wonkle.db', import.meta.url)));
db.exec(`
  CREATE TABLE IF NOT EXISTS puzzles (
    date TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plays (
    puzzle_date TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    score INTEGER NOT NULL,
    answers TEXT NOT NULL,
    image TEXT,
    PRIMARY KEY (puzzle_date, user_id)
  );
  CREATE TABLE IF NOT EXISTS posts (
    puzzle_date TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL
  );
`);
const getPuzzleRow = db.prepare('SELECT data FROM puzzles WHERE date = ?');
const insertPuzzle = db.prepare('INSERT INTO puzzles (date, data) VALUES (?, ?)');
const getPlay = db.prepare('SELECT score, answers FROM plays WHERE puzzle_date = ? AND user_id = ?');
const upsertPlay = db.prepare('INSERT OR REPLACE INTO plays (puzzle_date, user_id, username, score, answers) VALUES (?, ?, ?, ?, ?)');
const getPost = db.prepare('SELECT channel_id, message_id FROM posts WHERE puzzle_date = ?');
const upsertPost = db.prepare('INSERT OR REPLACE INTO posts (puzzle_date, channel_id, message_id) VALUES (?, ?, ?)');
const setPlayImage = db.prepare('UPDATE plays SET image = ? WHERE puzzle_date = ? AND user_id = ?');
const getPlayImages = db.prepare('SELECT user_id, image FROM plays WHERE puzzle_date = ? AND image IS NOT NULL ORDER BY score DESC, username');

const puzzleDate = new Date().toISOString().slice(0, 10);
let puzzle = null;

const messageLinks = () =>
  puzzle.messages.map((m) => (m.messageId ? `https://discord.com/channels/${GUILD_ID}/${m.channelId}/${m.messageId}` : null));

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

// TEST: lets all 5 messages come from the same author.
const TEST_ALLOW_SAME_AUTHOR = true;
// TEST: lets a player replay (overwrites their stored play instead of blocking).
const TEST_ALLOW_REPLAY = true;

async function buildPuzzle() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const candidates = [];
  const names = new Map();
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (channel?.type !== ChannelType.GuildText) continue;
    const perms = channel.permissionsFor(guild.members.me);
    if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
    const messages = await channel.messages.fetch({ limit: 100 });
    for (const msg of messages.values()) {
      // NOTE: at some point we might want to uncomment this... 
      // if (msg.author.bot || msg.content.length < 100) continue;
      if (msg.author.bot) continue;
      if (msg.attachments.size || msg.embeds.length) continue;
      if (/https?:\/\//i.test(msg.content)) continue;
      if (msg.mentions.users.size || msg.mentions.roles.size || msg.mentions.channels.size || msg.mentions.everyone) continue;
      candidates.push({ text: msg.content, authorId: msg.author.id, channelId: channel.id, messageId: msg.id });
      names.set(msg.author.id, msg.member?.displayName ?? msg.author.displayName);
    }
  }
  const picked = [];
  const usedAuthors = new Set();
  for (const msg of shuffle(candidates)) {
    if (usedAuthors.has(msg.authorId) && !TEST_ALLOW_SAME_AUTHOR) continue;
    usedAuthors.add(msg.authorId);
    picked.push(msg);
    if (picked.length === 5) break;
  }
  if (picked.length < 5) {
    throw new Error(`need 5 puzzle messages, found ${picked.length} (${candidates.length} eligible messages in scan)`);
  }
  // Red herrings are other authors seen in the scan 
  // NOTE: listing arbitrary guild members would require the privileged GuildMembers intent.
  const herrings = shuffle([...names.keys()].filter((id) => !usedAuthors.has(id))).slice(0, 3);
  puzzle = {
    messages: picked,
    options: shuffle([...usedAuthors, ...herrings].map((id) => ({ id, name: names.get(id) }))),
  };
}

client.once(Events.ClientReady, async () => {
  console.log(`logged in as ${client.user.tag}`);
  const row = getPuzzleRow.get(puzzleDate);
  if (row) {
    puzzle = JSON.parse(row.data);
    console.log(`loaded stored puzzle for ${puzzleDate}`);
    return;
  }
  try {
    await buildPuzzle();
    insertPuzzle.run(puzzleDate, JSON.stringify(puzzle));
    console.log(`built puzzle for ${puzzleDate}: ${puzzle.messages.length} messages, ${puzzle.options.length} options`);
  } catch (err) {
    console.error('failed to build puzzle:', err);
  }
});

const userCache = new Map();

async function requireUser(req, res, next) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'missing token' });
  if (!userCache.has(token)) {
    const r = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(401).json({ error: 'invalid token' });
    const u = await r.json();
    userCache.set(token, { id: u.id, username: u.global_name ?? u.username });
  }
  req.user = userCache.get(token);
  next();
}

const app = express();
// data URLs exceed body-parser default 100kb limit (some times!)
app.use(express.json({ limit: '2mb' }));

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

app.get('/api/puzzle', requireUser, (req, res) => {
  if (!puzzle) return res.status(503).json({ error: 'puzzle not ready' });
  const prior = TEST_ALLOW_REPLAY ? null : getPlay.get(puzzleDate, req.user.id);
  res.json({
    messages: puzzle.messages.map((m) => m.text),
    options: puzzle.options,
    played: prior
      ? { score: prior.score, answers: JSON.parse(prior.answers), correct: puzzle.messages.map((m) => m.authorId), links: messageLinks() }
      : null,
  });
});

app.post('/api/guess', requireUser, (req, res) => {
  if (!puzzle) return res.status(503).json({ error: 'puzzle not ready' });
  const correct = puzzle.messages.map((m) => m.authorId);
  const prior = getPlay.get(puzzleDate, req.user.id);
  if (prior && !TEST_ALLOW_REPLAY) {
    return res.json({ score: prior.score, answers: JSON.parse(prior.answers), correct, links: messageLinks(), alreadyPlayed: true });
  }
  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length !== puzzle.messages.length) {
    return res.status(400).json({ error: `expected ${puzzle.messages.length} answers` });
  }
  const score = correct.filter((id, i) => answers[i] === id).length;
  upsertPlay.run(puzzleDate, req.user.id, req.user.username, score, JSON.stringify(answers));
  res.json({ score, answers, correct, links: messageLinks() });
});

app.post('/api/publish', requireUser, async (req, res) => {
  if (!getPlay.get(puzzleDate, req.user.id)) return res.status(400).json({ error: 'you must play before publishing' });
  const { channelId, img } = req.body;
  if (!channelId || !img?.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'missing channelId or img' });
  }
  setPlayImage.run(img, puzzleDate, req.user.id);

  // Bumped (deleted and re-sent) on each publish so it stays at the bottom
  // NOTE: Discord allows up to 10 attachments per message and this might spam your channels and blow your server up, also what about rate limits ?
  const files = getPlayImages.all(puzzleDate).slice(0, 10).map((p) => ({
    attachment: Buffer.from(p.image.split(',')[1], 'base64'),
    name: `wonkle-${p.user_id}.png`,
  }));
  const content = `**Wonkle del ${puzzleDate}**`;

  const post = getPost.get(puzzleDate);
  if (post) {
    const oldChannel = await client.channels.fetch(post.channel_id).catch(() => null);
    const oldMessage = oldChannel && (await oldChannel.messages.fetch(post.message_id).catch(() => null));
    if (oldMessage) await oldMessage.delete().catch(() => {});
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return res.status(400).json({ error: 'invalid channelId' });
  const perms = channel.permissionsFor(client.user);
  if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return res.status(403).json({ error: 'bot cannot send messages to that channel' });
  }
  const sent = await channel.send({ content, files });
  upsertPost.run(puzzleDate, channelId, sent.id);
  res.json({ ok: true });
});

app.use(express.static(fileURLToPath(new URL('../client/dist', import.meta.url))));

app.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
client.login(DISCORD_BOT_TOKEN);
