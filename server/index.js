import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ApplicationCommandType,
  EntryPointCommandHandlerType,
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  Routes,
} from 'discord.js';

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, GUILD_ID, PORT = 3001 } = process.env;
const DEBUG = process.env.DEBUG === 'true';

// 100 messages per page. discord.js queues requests to respect Discord's
// 50/sec global limit, so paging deep is safe; this only bounds cold-start time.
const HISTORY_PAGES = 5;
// Difficulty ramp: the first message is long and quotable, the last is terse.
const MIN_LENGTHS = [100, 78, 55, 33, 10];
// Only applies when TEST_ALLOW_SAME_AUTHOR is off.
const MAX_PER_AUTHOR = 2;

// TEST: lets all 5 messages come from the same author.
const TEST_ALLOW_SAME_AUTHOR = false;
// TEST: lets a player replay (overwrites their stored play instead of blocking).
const TEST_ALLOW_REPLAY = false;

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
    hints TEXT,
    PRIMARY KEY (puzzle_date, user_id)
  );
  CREATE TABLE IF NOT EXISTS posts (
    puzzle_date TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL
  );
`);
// CREATE TABLE IF NOT EXISTS leaves existing tables alone, so new columns
// need this to reach databases that predate them.
try { db.exec('ALTER TABLE plays ADD COLUMN hints TEXT'); } catch {}

const getPuzzleRow = db.prepare('SELECT data FROM puzzles WHERE date = ?');
const insertPuzzle = db.prepare('INSERT INTO puzzles (date, data) VALUES (?, ?)');
const updatePuzzle = db.prepare('UPDATE puzzles SET data = ? WHERE date = ?');
const getPlay = db.prepare('SELECT score, answers, hints FROM plays WHERE puzzle_date = ? AND user_id = ?');
const upsertPlay = db.prepare('INSERT OR REPLACE INTO plays (puzzle_date, user_id, username, score, answers, hints) VALUES (?, ?, ?, ?, ?, ?)');
const getPost = db.prepare('SELECT channel_id, message_id FROM posts WHERE puzzle_date = ?');
const upsertPost = db.prepare('INSERT OR REPLACE INTO posts (puzzle_date, channel_id, message_id) VALUES (?, ?, ?)');
const setPlayImage = db.prepare('UPDATE plays SET image = ? WHERE puzzle_date = ? AND user_id = ?');
const getResults = db.prepare('SELECT user_id, score, image FROM plays WHERE puzzle_date = ? AND image IS NOT NULL ORDER BY score DESC, username');

const dateIn = (days) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
  });
const today = () => dateIn(0);
const tomorrow = () => dateIn(1);

let cache = { date: null, promise: null };

function msUntilRollover() {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const n = (t) => Number(p.find((x) => x.type === t).value);
  const h = n('hour') % 24; // hour12:false puede devolver 24 a medianoche
  return ((23 - h) * 3600 + (59 - n('minute')) * 60 + (60 - n('second'))) * 1000;
}

async function warm() {
  try {
    await getPuzzle();
    await loadPuzzle(tomorrow());
  } catch (err) {
    console.error('failed to warm puzzles:', err);
    setTimeout(warm, 60_000).unref();
  }
}

function scheduleRollover() {
  setTimeout(async () => {
    await warm();
    scheduleRollover();
  }, msUntilRollover() + 1_000).unref();
}

function getPuzzle() {
  const date = today();
  if (cache.date !== date) {
    cache = { date, promise: loadPuzzle(date) };
    // a failed build must not be cached, or the day stays broken
    cache.promise.catch(() => (cache = { date: null, promise: null }));
  }
  return cache.promise;
}

async function loadPuzzle(date) {
  const row = getPuzzleRow.get(date);
  if (row) {
    const puzzle = JSON.parse(row.data);
    // rows written before hints were prefetched
    if (puzzle.messages.some((m) => !m.hint)) {
      await addHints(puzzle);
      updatePuzzle.run(JSON.stringify(puzzle), date);
      console.log(`backfilled hints for ${date}`);
    }
    return puzzle;
  }
  const puzzle = await buildPuzzle();
  await addHints(puzzle);
  insertPuzzle.run(date, JSON.stringify(puzzle));
  console.log(`built puzzle for ${date}`);
  return puzzle;
}

// Prefetched once per puzzle rather than per player asking, so the hint is
// instant and its images can be preloaded by the client.
async function addHints(puzzle) {
  for (const msg of puzzle.messages) {
    msg.hint = msg.messageId ? await neighbours(msg.channelId, msg.messageId) : { before: null, after: null };
  }
}

async function neighbours(channelId, messageId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return { before: null, after: null };
  const grab = async (direction) => {
    const batch = await channel.messages.fetch({ limit: 1, [direction]: messageId }).catch(() => null);
    const m = batch?.first();
    return m
      ? {
          id: m.author.id,
          name: m.member?.displayName ?? m.author.displayName,
          avatar: m.author.avatar,
          text: m.content,
          images: [...m.attachments.values()]
            .filter((a) => a.contentType?.startsWith('image/'))
            .slice(0, 4)
            .map((a) => a.url),
        }
      : null;
  };
  return { before: await grab('before'), after: await grab('after') };
}

const messageTimes = (puzzle) =>
  puzzle.messages.map((m) => (m.messageId ? Number(BigInt(m.messageId) >> 22n) + 1420070400000 : null));

const messageLinks = (puzzle) =>
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

// messages used on a previous day never come back
function usedMessageIds() {
  const ids = new Set();
  for (const row of db.prepare('SELECT data FROM puzzles').all()) {
    for (const m of JSON.parse(row.data).messages) if (m.messageId) ids.add(m.messageId);
  }
  return ids;
}

async function buildPuzzle() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const used = usedMessageIds();
  const shortest = MIN_LENGTHS.at(-1);
  const candidates = [];
  const names = new Map();
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (channel?.type !== ChannelType.GuildText) continue;
    const perms = channel.permissionsFor(guild.members.me);
    if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
    let before;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
      if (!batch.size) break;
      before = batch.last().id;
      for (const msg of batch.values()) {
        if (msg.author.bot || used.has(msg.id)) continue;
        if (msg.content.length < shortest) continue;
        if (msg.attachments.size || msg.embeds.length) continue;
        if (/https?:\/\//i.test(msg.content)) continue;
        if (msg.mentions.users.size || msg.mentions.roles.size || msg.mentions.channels.size || msg.mentions.everyone) continue;
        candidates.push({ text: msg.content, authorId: msg.author.id, channelId: channel.id, messageId: msg.id });
        names.set(msg.author.id, { name: msg.member?.displayName ?? msg.author.displayName, avatar: msg.author.avatar });
      }
      if (batch.size < 100) break; // reached the start of the channel
    }
  }

  const pool = shuffle(candidates);
  const perAuthor = new Map();
  const cap = TEST_ALLOW_SAME_AUTHOR ? MIN_LENGTHS.length : MAX_PER_AUTHOR;
  const picked = [];
  const underCap = (m) => (perAuthor.get(m.authorId) ?? 0) < cap;
  for (const min of MIN_LENGTHS) {
    let at = pool.findIndex((m) => m.text.length >= min && underCap(m));
    // too few long messages to fill this slot: settle for the longest left
    if (at === -1) {
      at = pool.reduce(
        (best, m, i) => (underCap(m) && (best < 0 || m.text.length > pool[best].text.length) ? i : best),
        -1,
      );
    }
    if (at === -1) break;
    const [msg] = pool.splice(at, 1);
    perAuthor.set(msg.authorId, (perAuthor.get(msg.authorId) ?? 0) + 1);
    picked.push(msg);
  }
  if (picked.length < MIN_LENGTHS.length) {
    throw new Error(
      `need ${MIN_LENGTHS.length} puzzle messages, found ${picked.length} (${candidates.length} unused candidates in scan)`,
    );
  }
  const usedAuthors = new Set(picked.map((m) => m.authorId));
  // Red herrings are other authors seen in the scan
  // NOTE: listing arbitrary guild members would require the privileged GuildMembers intent.
  const herrings = shuffle([...names.keys()].filter((id) => !usedAuthors.has(id))).slice(0, 3);
  return {
    messages: picked,
    options: shuffle([...usedAuthors, ...herrings].map((id) => ({ id, ...names.get(id) }))),
  };
}

// ---------------------------------------------------------------------------
//   Entry Point command (type 4) is what the blue button in the App
//   CHAT_INPUT commands (type 1) are the ones that show up when you type "/"
// ---------------------------------------------------------------------------

const DESCRIPTION = "Play today's Wonkle";

const INTEGRATION_TYPES = [
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
];

const CONTEXTS = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];

// every name here becomes a "/" command that opens the Activity
const ACTIVITY_COMMANDS = ['play', 'wonkle'];

const COMMANDS = [
  {
    name: 'launch',
    description: DESCRIPTION,
    type: ApplicationCommandType.PrimaryEntryPoint,
    handler: EntryPointCommandHandlerType.DiscordLaunchActivity,
    integrationTypes: INTEGRATION_TYPES,
    contexts: CONTEXTS,
  },
  ...ACTIVITY_COMMANDS.map((name) => ({
    name,
    description: DESCRIPTION,
    type: ApplicationCommandType.ChatInput,
    integrationTypes: INTEGRATION_TYPES,
    contexts: CONTEXTS,
  })),
];

const canonical = (c) =>
  JSON.stringify({
    name: c.name,
    description: c.description,
    type: c.type,
    handler: c.handler ?? null,
    integrationTypes: [...(c.integrationTypes ?? [])].sort(),
    contexts: [...(c.contexts ?? [])].sort(),
  });

async function registerCommands() {
  const existing = await client.application.commands.fetch();
  const want = COMMANDS.map(canonical).sort();
  const have = [...existing.values()].map(canonical).sort();
  if (JSON.stringify(want) === JSON.stringify(have)) {
    console.log(`commands already registered: ${COMMANDS.map((c) => c.name).join(', ')}`);
    return;
  }
  await client.application.commands.set(COMMANDS);
  console.log(`registered commands: ${COMMANDS.map((c) => c.name).join(', ')}`);
}

async function launchActivity(interaction) {
  if (typeof interaction.launchActivity === 'function') {
    return interaction.launchActivity();
  }
  return client.rest.post(Routes.interactionCallback(interaction.id, interaction.token), {
    body: { type: 12, data: {} },
    auth: false,
  });
}

client.once(Events.ClientReady, async () => {
  console.log(`logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('failed to register commands:', err);
  }
  // warm the cache so the first player of the day doesn't wait on the scan
  await warm();
  scheduleRollover();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!ACTIVITY_COMMANDS.includes(interaction.commandName)) return;
  try {
    await launchActivity(interaction);
  } catch (err) {
    console.error(`failed to launch activity for /${interaction.commandName}:`, err);
    if (interaction.replied || interaction.deferred) return;
    await interaction
      .reply({
        content: 'No pude abrir la actividad.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
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
app.use(express.json({ limit: '8mb' }));

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

app.post('/api/log', (req, res) => {
  if (DEBUG) console.log('[client]', JSON.stringify(req.body));
  res.json({ ok: true });
});

app.get('/api/results', requireUser, (req, res) => {
  const date = today();
  if (!getPlay.get(date, req.user.id)) return res.status(403).json({ error: 'play first' });
  res.json(
    getResults
      .all(date)
      .filter((r) => r.user_id !== req.user.id)
      .map(({ score, image }) => ({ score, image })),
  );
});

app.get('/api/puzzle', requireUser, async (req, res) => {
  const date = today();
  const puzzle = await getPuzzle();
  const prior = TEST_ALLOW_REPLAY ? null : getPlay.get(date, req.user.id);
  res.json({
    messages: puzzle.messages.map((m) => m.text),
    times: messageTimes(puzzle),
    hints: puzzle.messages.map((m) => m.hint ?? { before: null, after: null }),
    options: puzzle.options,
    played: prior
      ? {
          score: prior.score,
          answers: JSON.parse(prior.answers),
          hints: JSON.parse(prior.hints ?? 'null'),
          correct: puzzle.messages.map((m) => m.authorId),
          links: messageLinks(puzzle),
        }
      : null,
  });
});

app.post('/api/guess', requireUser, async (req, res) => {
  const date = today();
  const puzzle = await getPuzzle();
  const correct = puzzle.messages.map((m) => m.authorId);
  const prior = getPlay.get(date, req.user.id);
  if (prior && !TEST_ALLOW_REPLAY) {
    return res.json({
      score: prior.score,
      answers: JSON.parse(prior.answers),
      hints: JSON.parse(prior.hints ?? 'null'),
      correct,
      links: messageLinks(puzzle),
      alreadyPlayed: true,
    });
  }
  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length !== puzzle.messages.length) {
    return res.status(400).json({ error: `expected ${puzzle.messages.length} answers` });
  }
  // which messages were solved with a hint, for the yellow squares
  const hints = puzzle.messages.map((_, i) => Array.isArray(req.body.hints) && !!req.body.hints[i]);
  const score = correct.filter((id, i) => answers[i] === id).length;
  upsertPlay.run(date, req.user.id, req.user.username, score, JSON.stringify(answers), JSON.stringify(hints));
  res.json({ score, answers, hints, correct, links: messageLinks(puzzle) });
});

app.post('/api/publish', requireUser, async (req, res) => {
  const date = today();
  if (!getPlay.get(date, req.user.id)) return res.status(400).json({ error: 'you must play before publishing' });
  const { channelId, img, composite } = req.body;
  if (!channelId || !img?.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'missing channelId or img' });
  }
  setPlayImage.run(img, date, req.user.id);
  const files = [{
    attachment: Buffer.from((composite ?? img).split(',')[1], 'base64'),
    name: `wonkle-${date}.png`,
  }];
  const content = `**Wonkle del ${date}**`;

  const post = getPost.get(date);
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
  upsertPost.run(date, channelId, sent.id);
  res.json({ ok: true });
});

app.use(express.static(fileURLToPath(new URL('../client/dist', import.meta.url))));

app.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
client.login(DISCORD_BOT_TOKEN);