// js/admin.js — administrator console. Every action is re-checked and logged by the data layer.
(async function () {
  'use strict';
  const { api, el, fmtEur, fmtDate, groupAccount, requireUser, wireLogout, entryLabel, toast } = Bank;

  const admin = await requireUser('admin');
  if (!admin) return;
  wireLogout(document.getElementById('logoutBtn'));
  document.getElementById('adminName').textContent = admin.name;

  const $ = (id) => document.getElementById(id);
  const dlg = $('dlg');
  let uid = 0;

  // ---------- small helpers ----------
  function showDialog(title, content, buttons, wide) {
    dlg.classList.toggle('wide', !!wide);
    $('dlgBody').replaceChildren(el('h2', { text: title }), content);
    $('dlgFoot').replaceChildren(...buttons);
    if (!dlg.open) dlg.showModal();
  }
  const closeBtn = () => el('button', { type: 'button', class: 'btn btn-secondary', text: 'Close', onclick: () => dlg.close() });
  const errorBox = () => el('div', { class: 'alert error', role: 'alert', hidden: true });
  const showErr = (box, e) => { box.textContent = e.message; box.hidden = false; };
  function field(labelText, input, hint) {
    input.id = 'f' + (++uid);
    return el('div', { class: 'field' }, el('label', { for: input.id, text: labelText }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
  }
  const secretBox = (lines) =>
    el('div', { class: 'secret-box' },
      ...lines.map(([k, v]) => el('div', {}, el('span', { class: 'muted', text: k + ': ' }), el('span', { class: 'mono', text: v }))),
      el('span', { class: 'muted', text: 'Shown only once. Give it to the customer through a secure channel.' }));
  async function guarded(fn) {
    try { await fn(); } catch (e) {
      if (e.status === 401) return location.replace('index.html');
      toast(e.message, 'error');
    }
  }

  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll('.tab')];
  const loaders = { customers: loadUsers, messages: loadMessages, limits: loadLimits, audit: loadAudit };
  function selectTab(name) {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    guarded(loaders[name]);
  }
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // ---------- customers ----------
  async function loadUsers() {
    const { users } = await api('GET', '/api/admin/users');
    const btn = (text, fn, cls) => el('button', { type: 'button', class: 'btn btn-sm ' + (cls || 'btn-secondary'), text, onclick: fn });
    $('usersBody').replaceChildren(...users.map((u) =>
      el('tr', {},
        el('td', { class: 'mono', text: groupAccount(u.account) }),
        el('td', { text: u.name }),
        el('td', {}, el('span', { class: 'badge ' + u.status, text: u.status })),
        el('td', { class: 'num', text: fmtEur(u.balance_cents) }),
        el('td', {}, el('div', { class: 'row-actions' },
          btn('Ledger', () => guarded(() => openLedger(u))),
          btn('Edit', () => editUser(u)),
          btn('Adjust', () => adjustBalance(u)),
          btn('Password', () => resetPassword(u)),
          u.status === 'active'
            ? btn('Block', () => setStatus(u, 'blocked'), 'btn-danger')
            : btn('Unblock', () => setStatus(u, 'active')),
        )),
      )));
  }

  $('createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('createError');
    err.hidden = true;
    guarded(async () => {
      try {
        const r = await api('POST', '/api/admin/users', { name: $('newName').value, password: $('newPassword').value });
        $('createdBox').replaceChildren(secretBox([['Name', r.name], ['Account number', groupAccount(r.account)], ['Password', r.password]]));
        $('createdBox').hidden = false;
        $('createForm').reset();
        loadUsers();
      } catch (ex) {
        if (ex.status === 401) throw ex;
        showErr(err, ex);
      }
    });
  });

  function editUser(u) {
    const name = el('input', { type: 'text', value: u.name, maxlength: '80' });
    const err = errorBox();
    const save = el('button', {
      type: 'button', class: 'btn', text: 'Save',
      onclick: () => guarded(async () => {
        try {
          await api('PATCH', '/api/admin/users/' + u.id, { name: name.value });
          dlg.close(); toast('Saved'); loadUsers();
        } catch (ex) { if (ex.status === 401) throw ex; showErr(err, ex); }
      }),
    });
    showDialog('Edit customer', el('div', { class: 'form' }, err, field('Full name', name, 'Account ' + groupAccount(u.account))), [closeBtn(), save]);
  }

  function setStatus(u, status) {
    const verb = status === 'blocked' ? 'Block' : 'Unblock';
    if (!confirm(verb + ' ' + u.name + '?' + (status === 'blocked' ? ' They will be signed out and cannot send or receive money.' : ''))) return;
    guarded(async () => {
      await api('PATCH', '/api/admin/users/' + u.id, { status });
      toast(u.name + ': ' + status);
      loadUsers();
    });
  }

  function adjustBalance(u) {
    const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: '250.00 or -40.50', autocomplete: 'off' });
    const reason = el('input', { type: 'text', maxlength: '140', placeholder: 'Why is this adjustment needed?' });
    const err = errorBox();
    const save = el('button', {
      type: 'button', class: 'btn', text: 'Post adjustment',
      onclick: () => guarded(async () => {
        if (!/^[+-]?\d{1,10}([.,]\d{1,2})?$/.test(amount.value.trim())) return showErr(err, { message: 'Enter an amount such as 250.00 or -40.50.' });
        try {
          const r = await api('POST', '/api/admin/adjustments', { user_id: u.id, amount: amount.value, reason: reason.value });
          dlg.close(); toast('Adjustment posted. New balance ' + fmtEur(r.balance_cents)); loadUsers();
        } catch (ex) { if (ex.status === 401) throw ex; showErr(err, ex); }
      }),
    });
    showDialog('Adjust balance · ' + u.name, el('div', { class: 'form' },
      el('p', { class: 'muted', text: 'Adds a new entry labelled "Adjustment by administrator" to the history. Existing entries are never edited. Use a negative amount to deduct.' }),
      err, field('Amount (EUR)', amount), field('Reason (visible to the customer, logged)', reason)), [closeBtn(), save]);
  }

  function resetPassword(u) {
    const pw = el('input', { type: 'text', autocomplete: 'off', placeholder: 'Leave empty to generate' });
    const err = errorBox();
    const save = el('button', {
      type: 'button', class: 'btn', text: 'Reset password',
      onclick: () => guarded(async () => {
        try {
          const r = await api('POST', '/api/admin/users/' + u.id + '/password', { password: pw.value });
          showDialog('Password reset · ' + u.name, secretBox([['New password', r.password]]), [closeBtn()]);
        } catch (ex) { if (ex.status === 401) throw ex; showErr(err, ex); }
      }),
    });
    showDialog('Reset password · ' + u.name, el('div', { class: 'form' },
      el('p', { class: 'muted', text: 'The customer is signed out everywhere.' }), err, field('New password', pw)), [closeBtn(), save]);
  }

  async function openLedger(u) {
    const d = await api('GET', '/api/admin/users/' + u.id + '/ledger');
    const reversible = (e) => ['transfer_out', 'transfer_in', 'adjustment'].includes(e.kind) && !e.is_reversed;
    const rows = d.entries.map((e) => {
      const l = entryLabel(e);
      return el('tr', {},
        el('td', { text: fmtDate(e.created_at) }),
        el('td', {}, el('div', { text: l.title }), l.sub ? el('div', { class: 'muted', text: l.sub }) : null,
          e.is_reversed ? el('span', { class: 'badge neutral', text: 'reversed' }) : null),
        el('td', { class: 'num', text: fmtEur(e.amount_cents) }),
        el('td', {}, reversible(e)
          ? el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Reverse', onclick: () => reverseFlow(u, e) })
          : null),
      );
    });
    showDialog(u.name + ' · ledger', el('div', { class: 'grid-gap' },
      el('p', { class: 'muted', text: 'Balance ' + fmtEur(d.balance_cents) + '. Entries are permanent; mistakes are corrected with a reversal.' }),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Date' }), el('th', { text: 'Entry' }), el('th', { class: 'num', text: 'Amount' }), el('th'))),
        el('tbody', {}, rows)))), [closeBtn()], true);
  }

  function reverseFlow(u, e) {
    const reason = el('input', { type: 'text', maxlength: '140', placeholder: 'Reason for the reversal' });
    const err = errorBox();
    const isTransfer = e.kind !== 'adjustment';
    const go = el('button', {
      type: 'button', class: 'btn', text: 'Confirm reversal',
      onclick: () => guarded(async () => {
        try {
          await api('POST', '/api/admin/reversals', { ref: e.ref, reason: reason.value });
          toast('Reversed'); loadUsers(); await openLedger(u);
        } catch (ex) { if (ex.status === 401) throw ex; showErr(err, ex); }
      }),
    });
    showDialog('Reverse entry', el('div', { class: 'form' },
      el('p', { text: entryLabel(e).title + ' · ' + fmtEur(e.amount_cents) }),
      isTransfer ? el('p', { class: 'alert warn', text: 'This reverses both sides of the transfer: the sender is refunded and the recipient is debited.' }) : null,
      err, field('Reason (logged)', reason)), [el('button', { type: 'button', class: 'btn btn-secondary', text: 'Back', onclick: () => guarded(() => openLedger(u)) }), go]);
  }

  // ---------- messages ----------
  async function loadMessages() {
    const { messages } = await api('GET', '/api/admin/messages');
    $('messagesList').replaceChildren(...messages.map((m) => {
      const ta = el('textarea', { maxlength: '300', rows: '2', 'aria-label': 'Message for ' + m.code, text: m.text });
      const err = errorBox();
      const save = el('button', {
        type: 'button', class: 'btn btn-sm', text: 'Save',
        onclick: () => guarded(async () => {
          try {
            await api('PUT', '/api/admin/messages', { code: m.code, text: ta.value });
            toast('Message saved');
          } catch (ex) { if (ex.status === 401) throw ex; showErr(err, ex); }
        }),
      });
      return el('div', { class: 'msg-card' },
        el('div', { class: 'section-header' }, el('h3', { text: m.code }), el('div', { class: 'msg-actions' }, save)),
        el('p', { class: 'muted', text: m.description }),
        ta, err,
        m.placeholders && m.placeholders.length
          ? el('div', { class: 'chips' }, ...m.placeholders.map((p) => el('span', { class: 'chip', text: '{' + p + '}' })))
          : null,
        el('p', { class: 'hint muted', text: 'Default: ' + m.default }),
      );
    }));
  }

  // ---------- limits ----------
  async function loadLimits() {
    const s = await api('GET', '/api/admin/settings');
    $('singleLimit').value = (s.single_limit_cents / 100).toFixed(2);
    $('dailyLimit').value = (s.daily_limit_cents / 100).toFixed(2);
  }

  $('limitsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('limitsError');
    err.hidden = true;
    guarded(async () => {
      try {
        await api('PUT', '/api/admin/settings', { single_limit: $('singleLimit').value, daily_limit: $('dailyLimit').value });
        toast('Limits saved');
      } catch (ex) { if (ex.status === 401) throw ex; showErr(err, ex); }
    });
  });

  // ---------- audit ----------
  async function loadAudit() {
    const { entries } = await api('GET', '/api/admin/audit?limit=200');
    $('auditBody').replaceChildren(...entries.map((a) =>
      el('tr', {},
        el('td', { text: fmtDate(a.created_at) }),
        el('td', { text: a.actor_name || '—' }),
        el('td', {}, el('span', { class: 'badge neutral', text: a.action })),
        el('td', { text: a.target || '' }),
        el('td', { class: 'muted', text: a.details || '' }),
      )));
  }

  $('auditRefresh').addEventListener('click', () => guarded(loadAudit));

  selectTab('customers');
})();
