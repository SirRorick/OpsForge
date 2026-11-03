// The prefab library's admin page. Every action is a POST to /api/admin/act
// carrying the session cookie; the server checks the session on each one, so
// nothing on this page is a control in itself. Everything a contributor typed
// is put on the page as text, never as markup.

const $ = (id) => document.getElementById(id);
let state = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function api(route, body) {
  const res = await fetch(`../api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || `The server answered ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function say(id, text, bad = false) {
  $(id).textContent = text || '';
  $(id).classList.toggle('bad', !!bad);
}

const when = (t) => (t ? new Date(t).toLocaleString() : '');

// -- signing in ---------------------------------------------------------------------

function showSignIn() {
  $('signin').hidden = false;
  $('dash').hidden = true;
  $('signout').hidden = true;
  $('who').textContent = '';
  $('email').focus();
}

$('send').onclick = async () => {
  say('signin-status', 'Sending…');
  try {
    const r = await api('admin/code', { email: $('email').value });
    say('signin-status', r.message);
    $('code-step').hidden = false;
    $('code').focus();
  } catch (err) { say('signin-status', err.message, true); }
};
$('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('send').click(); });

$('verify').onclick = async () => {
  say('signin-status', 'Checking…');
  try {
    await api('admin/verify', { email: $('email').value.trim().toLowerCase(), code: $('code').value });
    say('signin-status', '');
    await load();
  } catch (err) { say('signin-status', err.message, true); }
};
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('verify').click(); });

$('signout').onclick = async () => {
  try { await api('admin/logout', {}); } catch { /* signed out either way */ }
  showSignIn();
};

// -- the dashboard ---------------------------------------------------------------------

async function load() {
  try {
    state = await api('admin/state');
  } catch (err) {
    if (err.status === 401) return showSignIn();
    $('signin').hidden = true;
    $('dash').hidden = false;
    return say('dash-status', err.message, true);
  }
  $('signin').hidden = true;
  $('dash').hidden = false;
  $('signout').hidden = false;
  $('who').textContent = state.me.email;
  $('threshold').value = state.threshold;
  const { used, allowance, stops } = state.storage;
  $('storage').textContent = `${used} of ${allowance} uploads and saves used since the 1st (UTC). `
    + `New prefabs stop at ${stops.share}, reports at ${stops.report} and your own changes at ${stops.admin}, `
    + 'so the store never reaches the free plan’s limit, where it would stop for thirty days. Deleting is free.';
  render();
}

function render() {
  $('n-review').textContent = state.hidden.length || '';
  $('n-library').textContent = state.live.length || '';
  $('n-tags').textContent = state.tags.length || '';
  $('n-bans').textContent = state.bans.length || '';
  fill('review-list', state.hidden.map(prefabItem), 'Nothing is waiting for review.');
  renderLibrary();
  fill('tags-list', [...state.tags].sort((a, b) => b.reports.length - a.reports.length || b.uses - a.uses).map(tagItem),
    'Nobody has written a tag of their own yet.');
  fill('bans-list', state.bans.map(banItem), 'Nobody is banned.');
}

function renderLibrary() {
  const q = $('lib-filter').value.trim().toLowerCase();
  const hit = (r) => !q || [r.id, r.title, r.author.name, r.author.id, ...r.tags].some((s) => String(s).toLowerCase().includes(q));
  const list = state.live.filter(hit).sort((a, b) => b.reports.length - a.reports.length || b.created - a.created);
  fill('library-list', list.map(prefabItem), q ? 'Nothing matches.' : 'Nothing has been shared yet.');
}
$('lib-filter').addEventListener('input', renderLibrary);

function fill(id, nodes, empty) {
  const host = $(id);
  host.innerHTML = '';
  if (!nodes.length) host.appendChild(el('div', 'empty', empty));
  for (const n of nodes) host.appendChild(n);
}

/** A button that has to be pressed twice, the second time within three seconds. */
function armed(label, run) {
  const b = el('button', 'btn danger', label);
  let timer = null;
  b.onclick = () => {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = `Confirm ${label.toLowerCase()}`;
      timer = setTimeout(() => { b.classList.remove('armed'); b.textContent = label; }, 3000);
      return;
    }
    clearTimeout(timer);
    run();
  };
  return b;
}

function button(label, run, ghost = true) {
  const b = el('button', ghost ? 'btn ghost' : 'btn', label);
  b.onclick = run;
  return b;
}

async function act(body, done) {
  say('dash-status', 'Working…');
  try {
    const r = await api('admin/act', body);
    say('dash-status', done ? done(r) : 'Done.');
    await load();
  } catch (err) {
    if (err.status === 401) return showSignIn();
    say('dash-status', err.message, true);
  }
}

function prefabItem(r) {
  const item = el('div', 'item');
  const img = el('img');
  img.src = r.files.thumb;
  img.alt = '';
  img.loading = 'lazy';
  const body = el('div');
  body.appendChild(el('h3', null, r.title));
  const author = el('div', 'meta');
  author.append(`by ${r.author.name} · mod.io #${r.author.id}`);
  if (r.author.profile) {
    author.append(' · ');
    const a = el('a', null, 'profile');
    a.href = r.author.profile;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    author.append(a);
  }
  body.appendChild(author);
  body.appendChild(el('div', 'meta', `${r.id} · ${when(r.created)} · ${r.objects} pieces · ${r.size.join(' × ')} m`));
  if (r.description) body.appendChild(el('div', null, r.description));
  const tags = el('div', 'tags');
  for (const t of r.tags) tags.appendChild(el('span', 'tag', t));
  body.appendChild(tags);
  if (r.status !== 'live') body.appendChild(el('div', 'why', `Hidden: ${r.hiddenWhy || 'unknown'}`));
  if (r.reports.length) {
    const ul = el('ul', 'reports');
    for (const rep of r.reports) {
      const li = el('li', null, `${rep.reason}${rep.note ? ` — ${rep.note}` : ''} `);
      li.appendChild(el('small', null, `${rep.name} (#${rep.uid}) · ${when(rep.at)}`));
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  const acts = el('div', 'acts');
  if (r.status === 'live') {
    acts.appendChild(button('Hide', () => act({ action: 'hide', id: r.id })));
    if (r.reports.length) acts.appendChild(button('Dismiss reports', () => act({ action: 'dismiss', id: r.id })));
  } else {
    acts.appendChild(button('Restore', () => act({ action: 'restore', id: r.id }), false));
  }
  acts.appendChild(button('Edit', () => editForm(body, r)));
  acts.appendChild(armed('Delete', () => act({ action: 'delete', id: r.id }, () => `Deleted “${r.title}”.`)));
  acts.appendChild(armed('Ban author', () => {
    const reason = `prefab ${r.id}: ${r.reports[0]?.reason || 'moderation'}`;
    act({ action: 'ban', uid: r.author.id, reason }, (x) => `Banned ${r.author.name}; ${x.prefabs} prefab(s) hidden for review.`);
  }));
  item.append(img, body, acts);
  return item;
}

function editForm(host, r) {
  if (host.querySelector('.edit')) return;
  const f = el('div', 'edit');
  const title = el('input');
  title.value = r.title;
  const tags = el('input');
  tags.value = r.tags.join(', ');
  const desc = el('textarea');
  desc.rows = 2;
  desc.value = r.description || '';
  const save = button('Save', () => act({
    action: 'edit', id: r.id, title: title.value, description: desc.value,
    tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
  }), false);
  f.append(title, tags, desc, save);
  host.appendChild(f);
}

function tagItem(t) {
  const item = el('div', 'item tagitem');
  const body = el('div');
  body.appendChild(el('h3', null, t.slug));
  body.appendChild(el('div', 'meta', `${t.uses} prefab(s) · first used by ${t.byName || '?'} (#${t.by}) · ${when(t.at)}`));
  if (t.hidden) body.appendChild(el('div', 'why', `Hidden: ${t.hiddenWhy || 'unknown'}`));
  if (t.reports.length) {
    const ul = el('ul', 'reports');
    for (const rep of t.reports) {
      const li = el('li', null, `${rep.reason}${rep.note ? ` — ${rep.note}` : ''} `);
      li.appendChild(el('small', null, `${rep.name} (#${rep.uid}) · ${when(rep.at)}`));
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  const rename = el('div', 'row');
  const to = el('input');
  to.placeholder = 'Rename or merge into…';
  rename.append(to, button('Rename', () => to.value.trim() && act({ action: 'tag-rename', tag: t.slug, to: to.value },
    (x) => `Renamed on ${x.prefabs} prefab(s).`)));
  body.appendChild(rename);
  const acts = el('div', 'acts');
  acts.appendChild(t.hidden
    ? button('Restore', () => act({ action: 'tag-restore', tag: t.slug }), false)
    : button('Hide', () => act({ action: 'tag-hide', tag: t.slug })));
  acts.appendChild(armed('Delete', () => act({ action: 'tag-delete', tag: t.slug }, (x) => `Deleted; removed from ${x.prefabs} prefab(s).`)));
  item.append(body, acts);
  return item;
}

function banItem(u) {
  const item = el('div', 'item tagitem');
  const body = el('div');
  body.appendChild(el('h3', null, u.name));
  body.appendChild(el('div', 'meta', `mod.io #${u.id}${u.bannedAt ? ` · banned ${when(u.bannedAt)}` : ''}`));
  if (u.banReason) body.appendChild(el('div', null, u.banReason));
  const acts = el('div', 'acts');
  acts.appendChild(button('Unban', () => act({ action: 'unban', uid: u.id })));
  item.append(body, acts);
  return item;
}

$('ban-go').onclick = () => {
  const uid = $('ban-uid').value.trim();
  if (!/^\d+$/.test(uid)) return say('dash-status', 'A mod.io account id is a number.', true);
  act({ action: 'ban', uid, reason: $('ban-reason').value }, (x) => `Banned; ${x.prefabs} prefab(s) hidden for review.`);
};

$('threshold-save').onclick = () => act({ action: 'threshold', value: Number($('threshold').value) }, () => 'Saved.');

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== `pane-${b.dataset.tab}`;
  };
}

load();
