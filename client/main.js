import { DiscordSDK } from '@discord/embedded-app-sdk';

const CLIENT_ID = import.meta.env.DISCORD_CLIENT_ID;
const app = document.getElementById('app');
const player = document.getElementById('player');
const participants = document.getElementById('participants');

// is this even good practice question mark
let sdk;
let token;
let puzzle;
let me;
let others = [];
const answers = [];

// requests to the backend must use discords /.proxy prefix
// the activity proxy strips it before forwarding through the URL mapping.
async function api(path, body) {
  const res = await fetch(`/.proxy/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).error;
    throw new Error(`${path} failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

function showParticipants({ participants: list }) {
  participants.textContent = `In activity: ${list.map((p) => p.global_name ?? p.username).join(', ')}`;
}

function status(msg) {
  app.replaceChildren(el('p', msg));
}

// DEBUG=true in .env, then rebuild. Players can't open devtools inside
// Discord, so diagnostics go to the server log instead.
const DEBUG = import.meta.env.DEBUG === 'true';

function report(stage, detail = '') {
  if (!DEBUG) return;
  fetch('/.proxy/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, detail, params: location.search, ua: navigator.userAgent }),
  }).catch(() => {});
}

// must match the server's rollover, or the card is dated a different day
const puzzleDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// falls back to the default avatar Discord derives from the user id
const avatarUrl = (id, avatar, size) =>
  avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=${size}`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(id) >> 22n) % 6}.png`;

// sdk.ready() hangs forever rather than rejecting when Discord never answers
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

async function auth() {
  status('Starting SDK...');
  const params = new URLSearchParams(location.search);
  if (DEBUG) {
    report('env', JSON.stringify({ referrer: document.referrer, isTop: window === window.top, origin: location.origin }));
    const started = Date.now();
    let seen = 0;
    addEventListener('message', (e) => {
      if (seen++ < 8) report('rpc', `+${Date.now() - started}ms from ${e.origin}: ${JSON.stringify(e.data ?? null).slice(0, 200)}`);
    });
  }
  sdk = new DiscordSDK(CLIENT_ID);

  // SDK 2.5.0 addresses its handshake with `document.referrer` as the target
  // origin, which Discord drops for some clients (postMessage discards a
  // target-origin mismatch silently), leaving ready() hung forever. Re-send an
  // identical handshake addressed to '*'; the SDK's own listener takes the
  // READY that comes back. Retried once in case the first is sent too early.
  const handshake = () =>
    window.parent.postMessage(
      [0, { v: 1, encoding: 'json', client_id: CLIENT_ID, frame_id: params.get('frame_id') }],
      '*',
    );

  let connected = false;
  handshake();
  setTimeout(() => connected || handshake(), 2000);
  await withTimeout(
    sdk.ready(),
    100000,
    'Discord never answered. its over.',
  );
  connected = true;
  // layout_mode: 0 focused, 1 picture-in-picture, 2 grid
  sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
    document.body.classList.toggle('minimized', layout_mode !== 0);
  });
  status('Waiting for you to authorize Wonkle...');

  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });
  status('Exchanging token...');
  ({ access_token: token } = await api('token', { code }));
  status('Authenticating...');
  const auth = await sdk.commands.authenticate({ access_token: token });
  me = auth.user;
  player.textContent = `Playing as ${me.global_name ?? me.username}`;
  showParticipants(await sdk.commands.getInstanceConnectedParticipants());
  sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', showParticipants);
}

function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function showQuestion() {
  const i = answers.length;
  app.replaceChildren(
    el('h2', `Message ${i + 1} of ${puzzle.messages.length}`),
    el('blockquote', puzzle.messages[i]),
    el('p', 'Who wrote it?'),
  );
  const lock = el('button', 'Lock in');
  lock.disabled = true;
  let selected;
  const options = el('div');
  for (const option of puzzle.options) {
    const btn = el('button');
    const pfp = new Image();
    pfp.className = 'pfp';
    pfp.src = avatarUrl(option.id, option.avatar, 64);
    btn.append(pfp, option.name);
    btn.onclick = () => {
      selected = option.id;
      for (const b of options.children) b.classList.toggle('selected', b === btn);
      lock.disabled = false;
    };
    options.append(btn);
  }
  lock.onclick = () => {
    answers.push(selected);
    if (answers.length < puzzle.messages.length) showQuestion();
    else submit();
  };
  app.append(options, lock);
}

async function submit() {
  app.replaceChildren(el('p', 'Grading…'));
  const result = await api('guess', { answers });
  const dataUrl = await showResults(result);
  try {
    const all = [{ score: result.score, image: dataUrl }, ...others].sort((a, b) => b.score - a.score);
    await api('publish', {
      channelId: sdk.channelId,
      img: dataUrl,
      composite: await compositeImage(all.map((p) => p.image)),
    });
    app.append(el('p', 'Results posted to the channel.'));
  } catch (err) {
    app.append(el('p', `Failed to publish results: ${err.message}`));
  }
}

// one attachment per day instead of one per player: everyone's cards tiled
// into a single image, rebuilt by whoever publishes last
async function compositeImage(cards) {
  const W = 420;
  const H = 250;
  const gap = 14;
  const cols = Math.min(2, cards.length);
  const rows = Math.ceil(cards.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = (cols * W + gap * (cols + 1)) * 2;
  canvas.height = (rows * H + gap * (rows + 1)) * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.fillStyle = '#c1f2bf';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const images = await Promise.all(cards.map(loadImage));
  images.forEach((image, i) => {
    ctx.drawImage(image, gap + (i % cols) * (W + gap), gap + Math.floor(i / cols) * (H + gap), W, H);
  });
  return canvas.toDataURL('image/png');
}


function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}


async function resultsImage(score, right) {
  const name = me.global_name ?? me.username;
  const W = 420;
  const H = 250;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  ctx.fillStyle = '#dffcde';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 20);
  ctx.fill();

  const avatarSrc = avatarUrl(me.id, me.avatar, 128);
  ctx.save();
  ctx.beginPath();
  ctx.arc(56, 60, 28, 0, Math.PI * 2);
  ctx.clip();
  try {
    ctx.drawImage(await loadImage(avatarSrc), 28, 32, 56, 56);
  } catch {
    ctx.fillStyle = '#c4c0b6';
    ctx.fillRect(28, 32, 56, 56);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(name[0].toUpperCase(), 56, 70);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // canvas wont lazyload webfonts, forceload every single style
  await Promise.all([
    document.fonts.load('bold 22px "Noto Serif"'),
    document.fonts.load('italic 15px "Noto Serif"'),
    document.fonts.load('32px "Libre Barcode 39 Text"'),
  ]);

  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 22px "Noto Serif", serif';
  ctx.fillText(name, 100, 55);
  ctx.fillStyle = '#8a8578';
  ctx.font = 'italic 15px "Noto Serif", serif';
  ctx.fillText(`Wonkle del ${puzzleDate()}`, 100, 78);

  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 34px "Noto Serif", serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${score}/${right.length}`, W - 28, 68);
  ctx.textAlign = 'left';

  right.forEach((ok, i) => {
    ctx.fillStyle = ok ? '#6aaa64' : '#d64545';
    ctx.beginPath();
    ctx.roundRect(28 + i * 76, 120, 64, 64, 12);
    ctx.fill();
  });

  ctx.fillStyle = '#1a1a1a';
  ctx.font = '32px "Libre Barcode 39 Text"';
  ctx.textAlign = 'right';
  ctx.fillText('WONKLE', W - 25, H - 25);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

async function showResults({ score, answers: given, correct, links, alreadyPlayed }) {
  const names = Object.fromEntries(puzzle.options.map((o) => [o.id, o.name]));
  const right = given.map((id, i) => id === correct[i]);
  const dataUrl = await resultsImage(score, right);
  const img = new Image();
  img.src = dataUrl;
  img.style.cursor = 'pointer';
  img.title = 'Click a square to reveal that message';
  app.replaceChildren(img);
  if (alreadyPlayed) app.append(el('p', 'You already played today, here are your results.'));

  others = await api('results').catch(() => []);
  if (others.length) {
    const row = el('div');
    row.className = 'others';
    for (const other of others) {
      const thumb = new Image();
      thumb.src = other.image;
      row.append(thumb);
    }
    app.append(row);
  }

  const cards = puzzle.messages.map((text, i) => {
    const card = el('div');
    card.className = `result ${right[i] ? 'right' : 'wrong'}`;
    card.hidden = true;
    const verdict = el('p', `${right[i] ? 'PASS' : 'FAIL'} ${names[correct[i]]}${right[i] ? '' : `, YOU guessed ${names[given[i]]}`}`);
    verdict.className = 'verdict';
    card.append(el('blockquote', text), verdict);
    if (links?.[i]) {
      const jump = el('button', 'Jump to message...');
      jump.className = 'jump';
      jump.onclick = () => sdk.commands.openExternalLink({ url: links[i] });
      verdict.append(' ', jump);
    }
    return card;
  });

  const showAll = el('button', 'Show all results');
  showAll.onclick = () => cards.forEach((card) => (card.hidden = false));
  const showAllWrap = el('p');
  showAllWrap.append(showAll);
  app.append(showAllWrap, ...cards);

  // map clicks on the scaled image back to the tiles drawn at
  // x = 28 + i * 76, y = 120..184 in the card's 420x250 logical space
  img.onclick = (e) => {
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 420;
    const y = ((e.clientY - rect.top) / rect.height) * 250;
    if (y < 114 || y > 190) return;
    const i = Math.floor((x - 28) / 76);
    if (i < 0 || i >= cards.length || x - 28 - i * 76 > 70) return;
    cards.forEach((card, j) => (card.hidden = j !== i));
  };

  return dataUrl;
}

async function main() {
  report('boot');
  await auth();
  status('Loading puzzle...');
  puzzle = await api('puzzle');
  if (puzzle.played) await showResults({ ...puzzle.played, alreadyPlayed: true });
  else showQuestion();
}

main().catch((err) => {
  report('error', err.message);
  app.replaceChildren(el('p', `Error: ${err.message}`));
});
