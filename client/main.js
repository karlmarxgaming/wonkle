import { DiscordSDK } from '@discord/embedded-app-sdk';

const CLIENT_ID = import.meta.env.DISCORD_CLIENT_ID;
const app = document.getElementById('app');

let puzzle;
const answers = [];

// Requests to the backend must use Discord's /.proxy prefix; the activity
// proxy strips it before forwarding through the URL mapping.
async function api(path, body) {
  const res = await fetch(`/.proxy/api/${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).error;
    throw new Error(`${path} failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

async function auth() {
  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });
  const { access_token } = await api('token', { code });
  await sdk.commands.authenticate({ access_token });
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
    else showResults();
  };
  app.append(options, lock);
}

async function showResults() {
  app.replaceChildren(el('p', 'Grading…'));
  const { score, correct } = await api('guess', { answers });
  const names = Object.fromEntries(puzzle.options.map((o) => [o.id, o.name]));
  app.replaceChildren(el('h2', `Score: ${score} / ${puzzle.messages.length}`));
  puzzle.messages.forEach((text, i) => {
    const right = answers[i] === correct[i];
    app.append(
      el('blockquote', text),
      el('p', `${right ? '✔' : '✘'} ${names[correct[i]]}${right ? '' : ` — you guessed ${names[answers[i]]}`}`),
    );
  });
}

async function main() {
  await auth();
  puzzle = await api('puzzle');
  showQuestion();
}

main().catch((err) => app.replaceChildren(el('p', `Error: ${err.message}`)));
