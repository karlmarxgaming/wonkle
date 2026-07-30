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

async function auth() {
  sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();
  // layout_mode: 0 focused, 1 picture-in-picture, 2 grid
  sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
    document.body.classList.toggle('minimized', layout_mode !== 0);
  });
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });
  ({ access_token: token } = await api('token', { code }));
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
    const btn = el('button', option.name);
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
    await api('publish', {
      channelId: sdk.channelId,
      img: dataUrl,
    });
    app.append(el('p', 'Results posted to the channel.'));
  } catch (err) {
    app.append(el('p', `Failed to publish results: ${err.message}`));
  }
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

  const avatarSrc = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(me.id) >> 22n) % 6}.png`;
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
  ctx.fillText(`Wonkle del ${new Date().toISOString().slice(0, 10)}`, 100, 78);

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
  showAllWrap.style.textAlign = 'center';
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
  await auth();
  puzzle = await api('puzzle');
  if (puzzle.played) await showResults({ ...puzzle.played, alreadyPlayed: true });
  else showQuestion();
}

main().catch((err) => app.replaceChildren(el('p', `Error: ${err.message}`)));
