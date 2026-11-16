// --- Feedback ----------------------------------------------------------------
// Shared "Feedback" Firebase project, one branch per app. Same tree as Run App
// so the Feedback Admin app reads it: /ClaudeTerm/{name__email}/feedbacks/...
// Talks to the Realtime Database REST API; no SDK needed.

const FB_DB = 'https://cimen-feedback-default-rtdb.europe-west1.firebasedatabase.app';
const FB_APP = 'ClaudeTerm';
const FB_POLL_MS = 15000;

let fbProfile = null;
try {
  fbProfile = JSON.parse(localStorage.getItem('claudeterm-feedback-profile'));
} catch {}
let fbView = 'list';
let fbOpenId = null;
let fbItems = {};
let fbTimer = null;

const ft = (key) => t(currentLang, key);

// Same key format as Run App's FeedbackService.userKey.
function fbUserKey(name, email) {
  const clean = (s) =>
    s
      .replaceAll('.', '_dot_')
      .replaceAll('@', '_at_')
      .replaceAll('#', '_hash_')
      .replaceAll('$', '_dollar_')
      .replaceAll('[', '_lb_')
      .replaceAll(']', '_rb_')
      .replaceAll('/', '_slash_')
      .replaceAll(' ', '_');
  return `${clean(name)}__${clean(email)}`;
}

function fbUrl(path) {
  return `${FB_DB}/${FB_APP}/${fbUserKey(fbProfile.name, fbProfile.email)}${path}.json`;
}

async function fbRequest(method, path, body) {
  const res = await fetch(fbUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fbLang() {
  return currentLang || 'en';
}

async function fbLoad() {
  if (!fbProfile) return;
  try {
    fbItems = (await fbRequest('GET', '/feedbacks')) || {};
    updateFeedbackBadge();
    if ($('feedbackModal').classList.contains('open')) renderFeedback();
  } catch {}
}

// Admin replies newer than the user's last look count as unread.
function fbUnread(f) {
  const seen = Number(localStorage.getItem('claudeterm-feedback-seen-' + f.id) || 0);
  return Object.values(f.messages || {}).filter((m) => m.sender === 'admin' && m.timestamp > seen).length;
}

function fbList() {
  return Object.entries(fbItems)
    .map(([id, f]) => ({ id, ...f }))
    .filter((f) => !f.deletedByUser)
    .sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));
}

function updateFeedbackBadge() {
  const n = fbList().reduce((sum, f) => sum + fbUnread(f), 0);
  $('feedbackBadge').textContent = n;
  $('feedbackBadge').hidden = n === 0;
}

async function fbCreate(title, text) {
  const now = Date.now();
  const { name } = await fbRequest('POST', '/feedbacks', {
    title,
    createdAt: now,
    status: 'sent',
    lang: fbLang(),
    lastMessageText: text,
    lastMessageTimestamp: now,
  });
  await fbSend(name, text);
  return name;
}

async function fbSend(id, text) {
  const now = Date.now();
  await fbRequest('POST', `/feedbacks/${id}/messages`, { text, sender: 'user', timestamp: now });
  await fbRequest('PATCH', `/feedbacks/${id}`, { lastMessageText: text, lastMessageTimestamp: now });
}

function fbStatusLabel(s) {
  return ft('fb_status_' + (s || 'sent'));
}

function renderFeedback() {
  const body = $('feedbackBody');
  body.replaceChildren();
  $('feedbackTitle').textContent = ft('feedback');

  if (!fbProfile) {
    body.append(el('p', 'fbHint', ft('fb_profile_hint')));
    const name = el('input');
    name.placeholder = ft('fb_name');
    const email = el('input');
    email.type = 'email';
    email.placeholder = ft('fb_email');
    const err = el('p', 'fbError');
    const save = el('button', 'fbPrimary', ft('fb_continue'));
    save.addEventListener('click', () => {
      const n = name.value.trim();
      const e = email.value.trim();
      if (n.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
        err.textContent = ft('fb_profile_error');
        return;
      }
      fbProfile = { name: n, email: e };
      try {
        localStorage.setItem('claudeterm-feedback-profile', JSON.stringify(fbProfile));
      } catch {}
      fbRequest('PATCH', '', { name: n, email: e, lang: fbLang() }).catch(() => {});
      fbLoad();
      renderFeedback();
    });
    body.append(name, email, err, save);
    name.focus();
    return;
  }

  if (fbView === 'new') {
    const title = el('input');
    title.placeholder = ft('fb_subject');
    title.maxLength = 80;
    const text = el('textarea');
    text.placeholder = ft('fb_message');
    text.rows = 6;
    const err = el('p', 'fbError');
    const row = el('div', 'fbRow');
    const back = el('button', null, ft('cancel'));
    back.addEventListener('click', () => {
      fbView = 'list';
      renderFeedback();
    });
    const send = el('button', 'fbPrimary', ft('fb_send'));
    send.addEventListener('click', async () => {
      if (title.value.trim().length < 3 || !text.value.trim()) {
        err.textContent = ft('fb_new_error');
        return;
      }
      send.disabled = true;
      try {
        fbOpenId = await fbCreate(title.value.trim(), text.value.trim());
        fbView = 'thread';
        await fbLoad();
      } catch {
        err.textContent = ft('fb_send_error');
        send.disabled = false;
      }
    });
    row.append(back, send);
    body.append(title, text, err, row);
    title.focus();
    return;
  }

  if (fbView === 'thread' && fbItems[fbOpenId]) {
    const f = fbItems[fbOpenId];
    const head = el('div', 'fbRow');
    const back = el('button', null, '← ' + ft('fb_all'));
    back.addEventListener('click', () => {
      fbView = 'list';
      renderFeedback();
    });
    head.append(back, el('span', 'fbStatus ' + (f.status || 'sent'), fbStatusLabel(f.status)));
    body.append(head, el('h3', null, f.title || ''));
    const thread = el('div', 'fbThread');
    const msgs = Object.values(f.messages || {}).sort((a, b) => a.timestamp - b.timestamp);
    for (const m of msgs) {
      const b = el('div', 'fbMsg ' + (m.sender === 'admin' ? 'admin' : 'user'), m.text);
      b.title = new Date(m.timestamp).toLocaleString(currentLang);
      thread.append(b);
    }
    body.append(thread);
    try {
      localStorage.setItem('claudeterm-feedback-seen-' + fbOpenId, String(Date.now()));
    } catch {}
    updateFeedbackBadge();
    const reply = el('textarea');
    reply.placeholder = ft('fb_reply');
    reply.rows = 3;
    const send = el('button', 'fbPrimary', ft('fb_send'));
    send.addEventListener('click', async () => {
      const text = reply.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await fbSend(fbOpenId, text);
        await fbLoad();
      } catch {
        send.disabled = false;
      }
    });
    body.append(reply, send);
    thread.scrollTop = thread.scrollHeight;
    return;
  }

  const add = el('button', 'fbPrimary', '+ ' + ft('fb_new'));
  add.addEventListener('click', () => {
    fbView = 'new';
    renderFeedback();
  });
  body.append(add);
  const list = fbList();
  if (!list.length) body.append(el('p', 'fbHint', ft('fb_empty')));
  for (const f of list) {
    const row = el('button', 'fbItem');
    const top = el('span', 'fbItemTop');
    top.append(el('span', 'fbItemTitle', f.title || ''), el('span', 'fbStatus ' + (f.status || 'sent'), fbStatusLabel(f.status)));
    row.append(top, el('span', 'fbItemLast', f.lastMessageText || ''));
    const unread = fbUnread(f);
    if (unread) row.append(el('span', 'fbNew', `${unread} ${ft('fb_unread')}`));
    row.addEventListener('click', () => {
      fbOpenId = f.id;
      fbView = 'thread';
      renderFeedback();
    });
    body.append(row);
  }
}

function openFeedback() {
  fbView = 'list';
  renderFeedback();
  $('feedbackModal').classList.add('open');
  fbLoad();
}

function closeFeedback() {
  $('feedbackModal').classList.remove('open');
}

$('btnFeedback').addEventListener('click', openFeedback);
$('feedbackClose').addEventListener('click', closeFeedback);
$('feedbackModal').addEventListener('click', (e) => {
  if (e.target.id === 'feedbackModal') closeFeedback();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('feedbackModal').classList.contains('open')) closeFeedback();
});

function fillFeedbackLabels() {
  $('lblFeedback').textContent = ft('feedback');
}
$('langPicker').addEventListener('change', () => setTimeout(fillFeedbackLabels));
fillFeedbackLabels();
fbLoad();
fbTimer = setInterval(fbLoad, FB_POLL_MS);
