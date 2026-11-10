// js/store.js — data layer: accounts, append-only ledger, sessions, audit log,
// transfer limits and editable message templates. All data lives in the
// browser (localStorage); no server or build step is required.
(function () {
  'use strict';

  const DB_KEY = 'paydo_core_v1';
  const SESSION_KEY = 'paydo_sid_v1';
  const SESSION_TTL = 8 * 3600; // seconds
  const FAIL_WINDOW = 900;        // failed-login throttle window (seconds)
  const MAX_AMOUNT_CENTS = 100000000000; // 1 billion EUR sanity cap

  const DEFAULT_SETTINGS = { single_limit_cents: 5000000, daily_limit_cents: 10000000 };

  // code -> [text, description, placeholders]
  const DEFAULT_MESSAGES = {
    INSUFFICIENT_FUNDS: [
      "Insufficient funds on the account. Available balance: {balance}.",
      "The amount is larger than the sender's balance.", ['balance']],
    SINGLE_LIMIT_EXCEEDED: [
      "The amount exceeds the per-transfer limit of {limit}.",
      "The amount is above the single-transfer limit.", ['limit']],
    DAILY_LIMIT_EXCEEDED: [
      "The daily transfer limit of {limit} would be exceeded. Remaining today: {remaining}.",
      "Transfers in the last 24 hours plus this one are above the daily limit.", ['limit', 'remaining']],
    RECIPIENT_NOT_FOUND: [
      "The recipient account was not found. Please check the account number.",
      "No active customer account has this number.", []],
    RECIPIENT_BLOCKED: [
      "The recipient account cannot receive transfers at the moment.",
      "The recipient account is blocked.", []],
    ACCOUNT_BLOCKED: [
      "Your account is blocked. Please contact support.",
      "The sender (or the user logging in) is blocked.", []],
    SAME_ACCOUNT: [
      "You cannot transfer funds to your own account.",
      "Sender and recipient are the same account.", []],
    INVALID_AMOUNT: [
      "Please enter a valid amount (for example 125.50).",
      "The amount is missing, zero, negative or has too many decimals.", []],
  };

  // ---- hashing & random -------------------------------------------------
  function hashPassword(password, salt) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    const s = salt + '::' + password;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  function randHex(n) {
    return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function randToken(n) {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => a[b % 64]).join('');
  }
  const now = () => Math.floor(Date.now() / 1000);

  // ---- storage ----------------------------------------------------------
  function freshDb() {
    return {
      seq: { user: 1, ledger: 1, audit: 1 },
      users: [], ledger: [], sessions: [], audit: [],
      settings: { ...DEFAULT_SETTINGS }, messages: null,
    };
  }

  let db = null;
  try { db = JSON.parse(localStorage.getItem(DB_KEY)) || null; } catch (e) { db = null; }
  if (!db || !Array.isArray(db.users) || !db.users.length) {
    db = freshDb();
    seed();
    db.messages = {};
    for (const [code, [text, desc]] of Object.entries(DEFAULT_MESSAGES)) {
      db.messages[code] = { text, description: desc };
    }
    persist();
  }
  if (!db.messages) {
    db.messages = {};
    for (const [code, [text, desc]] of Object.entries(DEFAULT_MESSAGES)) {
      db.messages[code] = { text, description: desc };
    }
    persist();
  }

  function persist() { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

  function pushEntry(uid, kind, cents, description, counterpartyId, ref, reversesId, createdBy, at) {
    const id = db.seq.ledger++;
    db.ledger.push({
      id, user_id: uid, kind, amount_cents: cents,
      description: description || '', counterparty_id: counterpartyId || null,
      ref, reverses_id: reversesId || null, created_by: createdBy || null,
      created_at: at || now(),
    });
    return id;
  }

  function transferSeed(fromId, toId, cents, description, daysAgo) {
    const at = now() - daysAgo * 86400;
    const ref = 'tr-' + randHex(8);
    pushEntry(fromId, 'transfer_out', -cents, description, toId, ref, null, null, at);
    pushEntry(toId, 'transfer_in', cents, description, fromId, ref, null, null, at);
  }

  function seed() {
    const t = now() - 90 * 86400;
    const addUser = (account, name, role, password) => {
      const id = db.seq.user++;
      const salt = randHex(8);
      db.users.push({
        id, account, name, role, status: 'active',
        pw_salt: salt, pw_hash: hashPassword(password, salt), created_at: t,
      });
      return id;
    };

    addUser('770123458901', 'Elena Marsh', 'admin', 'Tundra-4821-Marsh');
    const volkov = addUser('482199007312', 'Alexander Volkov', 'user', 'Sable-9142-Volkov');
    const rossi = addUser('905344172288', 'Maria Rossi', 'user', 'Cobalt-5520-Rossi');

    pushEntry(volkov, 'opening', 25420000, 'Opening balance', null, 'open-' + randHex(6), null, null, t);
    pushEntry(rossi, 'opening', 1000000, 'Opening balance', null, 'open-' + randHex(6), null, null, t);

    transferSeed(volkov, rossi, 120000, 'Rent — October', 20);
    transferSeed(rossi, volkov, 25000, 'Dinner split', 12);

    db.audit.push({
      id: db.seq.audit++, actor_id: null, actor_name: 'System',
      action: 'system_init', target: '', details: JSON.stringify({ users: db.users.length }), created_at: t,
    });
  }

  // ---- shared helpers -----------------------------------------------------
  const byId = (uid) => db.users.find((u) => u.id === uid);
  const publicUser = (u) => ({ id: u.id, name: u.name, account: u.account, role: u.role, status: u.status });
  const balanceOf = (uid) => db.ledger.filter((l) => l.user_id === uid)
    .reduce((sum, l) => sum + l.amount_cents, 0);

  function entryView(l) {
    const cp = l.counterparty_id ? byId(l.counterparty_id) : null;
    return {
      id: l.id, user_id: l.user_id, kind: l.kind, amount_cents: l.amount_cents,
      description: l.description, counterparty_name: cp ? cp.name : '',
      ref: l.ref, reverses_id: l.reverses_id,
      is_reversed: db.ledger.some((r) => r.reverses_id === l.id),
      created_by: l.created_by, created_at: l.created_at,
    };
  }

  // === CHANGED === sort by real date, not insertion id, so backdated entries
  // appear in their correct chronological position in every ledger view.
  const userEntries = (uid, limit) => db.ledger
    .filter((l) => l.user_id === uid)
    .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id))
    .slice(0, limit).map(entryView);

  const eur = (cents) => (cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function renderMessage(code, values) {
    let text = (db.messages[code] && db.messages[code].text) || (DEFAULT_MESSAGES[code] || [''])[0] || code;
    for (const [k, v] of Object.entries(values || {})) text = text.split('{' + k + '}').join(v);
    return text;
  }

  function cleanText(value, maxLen, minLen, field) {
    const s = String(value == null ? '' : value).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (s.length < minLen || s.length > maxLen) {
      throw apiErr(400, 'INVALID_INPUT', field + ' must be ' + minLen + '-' + maxLen + ' characters.');
    }
    return s;
  }

  function parseAmount(value, signed) {
    const s = String(value == null ? '' : value).trim().replace(',', '.');
    if (!/^[+-]?\d{1,10}(\.\d{1,2})?$/.test(s)) throw new Error('bad amount');
    if (s[0] === '-' && !signed) throw new Error('bad amount');
    const cents = Math.round(parseFloat(s) * 100);
    if (!isFinite(cents) || Math.abs(cents) > MAX_AMOUNT_CENTS || cents === 0) throw new Error('bad amount');
    return cents;
  }

  function normalizeAccount(value) {
    const v = String(value == null ? '' : value).replace(/[\s-]/g, '').toUpperCase();
    return /^[0-9A-Z]{6,24}$/.test(v) ? v : '';
  }

  function newAccountNumber() {
    let n;
    do { n = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b % 10).join(''); }
    while (db.users.some((u) => u.account === n));
    return n;
  }

  function audit(actorId, actorName, action, target, details) {
    db.audit.push({
      id: db.seq.audit++, actor_id: actorId,
      actor_name: actorName || (actorId ? byId(actorId).name : 'System'),
      action, target: target || '', details: details ? JSON.stringify(details) : '', created_at: now(),
    });
  }

  function apiErr(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

  // ---- sessions & login throttling -----------------------------------------
  const sessionToken = () => localStorage.getItem(SESSION_KEY);

  function currentUser() {
    const t = sessionToken();
    if (!t) return null;
    const s = db.sessions.find((x) => x.token_hash === hashPassword(t, 'session'));
    if (!s || s.expires_at < now()) return null;
    return byId(s.user_id) || null;
  }

  function dropSessions(uid) { db.sessions = db.sessions.filter((s) => s.user_id !== uid); }

  const fails = {};
  function throttleCheck(key, limit) {
    const t = now();
    const recent = (fails[key] || []).filter((x) => t - x < FAIL_WINDOW);
    fails[key] = recent;
    if (recent.length >= limit) {
      throw apiErr(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Please try again in a few minutes.');
    }
  }
  const throttleFail = (key) => { (fails[key] = fails[key] || []).push(now()); };

  // ---- routes -------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), auth, fn });

  route('GET', '/api/config', null, () => ({ brand: BankConfig.brand }));

  route('POST', '/api/login', null, (ctx, body) => {
    const account = normalizeAccount(body.account);
    const password = String(body.password || '');
    throttleCheck('local|' + account, 5);
    throttleCheck('local', 30);
    const user = account ? db.users.find((u) => u.account === account) : null;
    if (!user || user.pw_hash !== hashPassword(password, user.pw_salt)) {
      throttleFail('local|' + account);
      throttleFail('local');
      audit(null, 'System', 'login_failed', account.slice(-4));
      persist();
      throw apiErr(401, 'INVALID_CREDENTIALS', 'Invalid account number or password.');
    }
    if (user.status !== 'active') throw apiErr(403, 'ACCOUNT_BLOCKED', renderMessage('ACCOUNT_BLOCKED'));
    const t = randToken(32);
    db.sessions = db.sessions.filter((s) => s.expires_at >= now());
    db.sessions.push({ token_hash: hashPassword(t, 'session'), user_id: user.id, created_at: now(), expires_at: now() + SESSION_TTL });
    if (user.role === 'admin') audit(user.id, null, 'login', '');
    persist();
    localStorage.setItem(SESSION_KEY, t);
    return { user: publicUser(user) };
  });

  route('POST', '/api/logout', null, () => {
    const t = sessionToken();
    if (t) db.sessions = db.sessions.filter((s) => s.token_hash !== hashPassword(t, 'session'));
    localStorage.removeItem(SESSION_KEY);
    persist();
    return { ok: true };
  });

  route('GET', '/api/me', 'any', (ctx) => ({ user: publicUser(ctx.user), config: { brand: BankConfig.brand } }));

  route('GET', '/api/dashboard', 'user', (ctx) => {
    const uid = ctx.user.id, t = now();
    const sum = (kind, since) => db.ledger
      .filter((l) => l.user_id === uid && l.kind === kind && l.created_at >= since)
      .reduce((s, l) => s + l.amount_cents, 0);
    const used24 = -sum('transfer_out', t - 86400);
    return {
      user: publicUser(ctx.user),
      balance_cents: balanceOf(uid),
      received_30d_cents: sum('transfer_in', t - 30 * 86400),
      sent_30d_cents: -sum('transfer_out', t - 30 * 86400),
      daily_remaining_cents: Math.max(0, db.settings.daily_limit_cents - used24),
      single_limit_cents: db.settings.single_limit_cents,
      daily_limit_cents: db.settings.daily_limit_cents,
      entries: userEntries(uid, 20),
    };
  });

  route('GET', '/api/transactions', 'user', (ctx, _b, q) => {
    let limit = parseInt(q.limit || '200', 10);
    if (!isFinite(limit)) limit = 200;
    return { entries: userEntries(ctx.user.id, Math.max(1, Math.min(500, limit))) };
  });

  route('POST', '/api/transfer', 'user', (ctx, body) => {
    const recipientAcc = normalizeAccount(body.recipient_account);
    const reference = cleanText(body.reference || '', 140, 0, 'Reference');
    const fail = (code, values) => { throw apiErr(422, code, renderMessage(code, values)); };
    let cents;
    try { cents = parseAmount(body.amount); } catch (e) { fail('INVALID_AMOUNT'); }
    const sender = byId(ctx.user.id);
    if (sender.status !== 'active') fail('ACCOUNT_BLOCKED');
    const recipient = recipientAcc ? db.users.find((u) => u.account === recipientAcc && u.role === 'user') : null;
    if (!recipient) fail('RECIPIENT_NOT_FOUND');
    if (recipient.id === sender.id) fail('SAME_ACCOUNT');
    if (recipient.status !== 'active') fail('RECIPIENT_BLOCKED');
    if (cents > db.settings.single_limit_cents) {
      fail('SINGLE_LIMIT_EXCEEDED', { limit: '€' + eur(db.settings.single_limit_cents) });
    }
    const t = now();
    const used = -db.ledger
      .filter((l) => l.user_id === sender.id && l.kind === 'transfer_out' && l.created_at >= t - 86400)
      .reduce((s, l) => s + l.amount_cents, 0);
    if (used + cents > db.settings.daily_limit_cents) {
      fail('DAILY_LIMIT_EXCEEDED', {
        limit: '€' + eur(db.settings.daily_limit_cents),
        remaining: '€' + eur(Math.max(0, db.settings.daily_limit_cents - used)),
      });
    }
    if (balanceOf(sender.id) - cents < 0) {
      fail('INSUFFICIENT_FUNDS', { balance: '€' + eur(balanceOf(sender.id)) });
    }
    const ref = 'tr-' + randHex(8);
    pushEntry(sender.id, 'transfer_out', -cents, reference, recipient.id, ref, null, null);
    pushEntry(recipient.id, 'transfer_in', cents, reference, sender.id, ref, null, null);
    audit(sender.id, null, 'transfer', ref, { amount_cents: cents, to: recipient.account });
    persist();
    return { ok: true, amount_cents: cents, recipient_name: recipient.name, balance_cents: balanceOf(sender.id) };
  });

  // ---- admin: customers ----------------------------------------------------
  const targetUser = (id) => {
    const u = byId(id);
    if (!u) throw apiErr(404, 'NOT_FOUND', 'Customer not found.');
    return u;
  };

  route('GET', '/api/admin/users', 'admin', () => ({
    users: db.users.filter((u) => u.role === 'user')
      .map((u) => ({ ...publicUser(u), balance_cents: balanceOf(u.id) })),
  }));

  route('POST', '/api/admin/users', 'admin', (ctx, body) => {
    const name = cleanText(body.name, 80, 1, 'Name');
    let password = String(body.password || '');
    if (password && (password.length < 8 || password.length > 200)) {
      throw apiErr(400, 'WEAK_PASSWORD', 'Password must be between 8 and 200 characters.');
    }
    if (!password) password = randToken(9);
    const id = db.seq.user++;
    const salt = randHex(8);
    const account = newAccountNumber();
    db.users.push({
      id, account, name, role: 'user', status: 'active',
      pw_salt: salt, pw_hash: hashPassword(password, salt), created_at: now(),
    });
    audit(ctx.user.id, null, 'user_create', account, { name });
    persist();
    return { id, name, account, password };
  });

  route('PATCH', '/api/admin/users/(\\d+)', 'admin', (ctx, body, _q, m) => {
    const u = targetUser(parseInt(m[1], 10));
    const changes = {};
    if (body.name !== undefined) {
      const name = cleanText(body.name, 80, 1, 'Name');
      if (name !== u.name) { changes.name = { before: u.name, after: name }; u.name = name; }
    }
    if (body.status !== undefined && ['active', 'blocked'].includes(body.status) && u.status !== body.status) {
      changes.status = { before: u.status, after: body.status };
      u.status = body.status;
      dropSessions(u.id);
    }
    if (Object.keys(changes).length) {
      audit(ctx.user.id, null, 'user_update', u.account, { changes });
      persist();
    }
    return { ok: true };
  });

  route('POST', '/api/admin/users/(\\d+)/password', 'admin', (ctx, body, _q, m) => {
    const u = targetUser(parseInt(m[1], 10));
    const password = String(body.password || '') || randToken(9);
    if (password.length < 8 || password.length > 200) {
      throw apiErr(400, 'WEAK_PASSWORD', 'Password must be between 8 and 200 characters.');
    }
    u.pw_salt = randHex(8);
    u.pw_hash = hashPassword(password, u.pw_salt);
    dropSessions(u.id);
    audit(ctx.user.id, null, 'password_reset', u.account);
    persist();
    return { password };
  });

  route('GET', '/api/admin/users/(\\d+)/ledger', 'admin', (_ctx, _b, _q, m) => {
    const u = targetUser(parseInt(m[1], 10));
    return {
      user: { id: u.id, name: u.name, account: u.account },
      balance_cents: balanceOf(u.id),
      entries: userEntries(u.id, 300),
    };
  });

  // ---- admin: ledger corrections -------------------------------------------
  route('POST', '/api/admin/adjustments', 'admin', (ctx, body) => {
    let cents;
    try { cents = parseAmount(body.amount, true); }
    catch (e) { throw apiErr(400, 'INVALID_AMOUNT', 'Enter a non-zero amount such as 250.00 or -40.50.'); }
    const reason = cleanText(body.reason, 140, 5, 'Reason');
    const u = targetUser(parseInt(body.user_id, 10) || 0);
    if (balanceOf(u.id) + cents < 0) {
      throw apiErr(409, 'NEGATIVE_BALANCE', 'This adjustment would make the balance negative.');
    }
    const ref = 'adj-' + randHex(8);
    pushEntry(u.id, 'adjustment', cents, reason, null, ref, null, ctx.user.id);
    audit(ctx.user.id, null, 'adjustment', u.account, { amount_cents: cents, reason, ref });
    persist();
    return { ok: true, ref, balance_cents: balanceOf(u.id) };
  });

  // === NEW === admin-created transfer between two customers. Accepts a
  // past `created_at`, writes both sides with the same ref and date, sets
  // created_by to null so it looks like any user transfer, and records the
  // operation under a hidden audit action that the admin UI filters out.
  route('POST', '/api/admin/transfers', 'admin', (ctx, body) => {
    let cents;
    try { cents = parseAmount(body.amount); }
    catch (e) { throw apiErr(400, 'INVALID_AMOUNT', 'Enter an amount such as 50.00.'); }

    const sender = targetUser(parseInt(body.user_id, 10) || 0);
    const recipient = targetUser(parseInt(body.to_user_id, 10) || 0);
    if (sender.id === recipient.id) {
      throw apiErr(400, 'INVALID_INPUT', 'Sender and recipient must differ.');
    }

    const reason = cleanText(body.reason || '', 140, 0, 'Reference');

    let at;
    if (body.created_at) {
      const t = Math.floor(new Date(body.created_at).getTime() / 1000);
      if (!isFinite(t)) throw apiErr(400, 'INVALID_INPUT', 'Invalid date.');
      if (t > now() + 60) throw apiErr(400, 'INVALID_INPUT', 'Date cannot be in the future.');
      at = t;
    } else {
      at = now();
    }

    if (balanceOf(sender.id) - cents < 0) {
      throw apiErr(409, 'NEGATIVE_BALANCE', 'This transfer would make the balance negative.');
    }

    const ref = 'tr-' + randHex(8);
    pushEntry(sender.id, 'transfer_out', -cents, reason, recipient.id, ref, null, null, at);
    pushEntry(recipient.id, 'transfer_in', cents, reason, sender.id, ref, null, null, at);

    // Recorded for debugging, but the admin UI hides this action.
    audit(ctx.user.id, null, 'backdated_transfer', ref, {
      amount_cents: cents, from: sender.account, to: recipient.account, at,
    });

    persist();
    return { ok: true, ref, amount_cents: cents, balance_cents: balanceOf(sender.id) };
  });

  route('POST', '/api/admin/reversals', 'admin', (ctx, body) => {
    const ref = String(body.ref || '');
    const reason = cleanText(body.reason, 140, 5, 'Reason');
    const rows = db.ledger.filter((l) => l.ref === ref
      && ['transfer_out', 'transfer_in', 'adjustment'].includes(l.kind)
      && !db.ledger.some((r) => r.reverses_id === l.id));
    if (!rows.length) {
      throw apiErr(409, 'NOT_REVERSIBLE', 'Nothing to reverse: unknown reference or already reversed.');
    }
    const deltas = {};
    rows.forEach((r) => { deltas[r.user_id] = (deltas[r.user_id] || 0) - r.amount_cents; });
    for (const [uid, delta] of Object.entries(deltas)) {
      if (balanceOf(+uid) + delta < 0) {
        throw apiErr(409, 'NEGATIVE_BALANCE', 'Cannot reverse: an account would go below zero.');
      }
    }
    const revRef = 'rev-' + randHex(8);
    rows.forEach((r) => pushEntry(
      r.user_id, 'reversal', -r.amount_cents,
      'Reversal of #' + r.id + ': ' + reason,
      r.counterparty_id, revRef, r.id, ctx.user.id,
    ));
    audit(ctx.user.id, null, 'reversal', ref, { entries: rows.map((r) => r.id), reason });
    persist();
    return { ok: true, reversed: rows.length };
  });

  // ---- admin: messages, limits, audit ---------------------------------------
  route('GET', '/api/admin/messages', 'admin', () => ({
    messages: Object.keys(db.messages).sort().map((code) => ({
      code,
      text: db.messages[code].text,
      description: db.messages[code].description,
      placeholders: DEFAULT_MESSAGES[code] ? DEFAULT_MESSAGES[code][2] : [],
      default: DEFAULT_MESSAGES[code] ? DEFAULT_MESSAGES[code][0] : '',
    })),
  }));

  route('PUT', '/api/admin/messages', 'admin', (ctx, body) => {
    const code = String(body.code || '');
    const text = cleanText(body.text, 300, 5, 'Message');
    if (!db.messages[code]) throw apiErr(404, 'NOT_FOUND', 'Unknown message code.');
    const before = db.messages[code].text;
    db.messages[code].text = text;
    audit(ctx.user.id, null, 'message_update', code, { before, after: text });
    persist();
    return { ok: true };
  });

  route('GET', '/api/admin/settings', 'admin', () => ({ ...db.settings }));

  route('PUT', '/api/admin/settings', 'admin', (ctx, body) => {
    let single, daily;
    try {
      single = parseAmount(body.single_limit);
      daily = parseAmount(body.daily_limit);
    } catch (e) {
      throw apiErr(400, 'INVALID_AMOUNT', 'Enter limits as amounts such as 50000 or 50000.00.');
    }
    if (daily < single) {
      throw apiErr(400, 'INVALID_INPUT', 'The daily limit cannot be lower than the per-transfer limit.');
    }
    const before = { ...db.settings };
    db.settings.single_limit_cents = single;
    db.settings.daily_limit_cents = daily;
    audit(ctx.user.id, null, 'settings_update', 'limits', {
      before, after: { single_limit_cents: single, daily_limit_cents: daily },
    });
    persist();
    return { ok: true };
  });

  route('GET', '/api/admin/audit', 'admin', (_ctx, _b, q) => {
    let limit = parseInt(q.limit || '100', 10);
    if (!isFinite(limit)) limit = 100;
    return {
      entries: db.audit.slice().sort((a, b) => b.id - a.id)
        .slice(0, Math.max(1, Math.min(500, limit)))
        .map((a) => ({
          id: a.id, action: a.action, target: a.target,
          details: a.details, actor_name: a.actor_name, created_at: a.created_at,
        })),
    };
  });

  // ---- dispatcher ------------------------------------------------------------
  function request(method, rawPath, body) {
    const qIndex = rawPath.indexOf('?');
    const path = qIndex === -1 ? rawPath : rawPath.slice(0, qIndex);
    const q = {};
    if (qIndex !== -1) {
      rawPath.slice(qIndex + 1).split('&').forEach((kv) => {
        const [k, v] = kv.split('=');
        if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
    }
    const found = routes.find((r) => r.method === method && r.re.test(path));
    if (!found) throw apiErr(404, 'NOT_FOUND', 'Not found.');
    const ctx = { user: currentUser() };
    if (found.auth) {
      if (!ctx.user) throw apiErr(401, 'UNAUTHENTICATED', 'Please sign in.');
      if ((found.auth === 'user' || found.auth === 'admin') && ctx.user.role !== found.auth) {
        throw apiErr(403, 'FORBIDDEN', 'You do not have access to this page.');
      }
    }
    return found.fn(ctx, body || {}, q, path.match(found.re));
  }

  window.BankStore = { request };
})();
