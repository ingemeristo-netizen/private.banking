// js/dashboard.js — customer dashboard. Data comes from the server; nothing is stored in the browser.
(async function () {
  'use strict';
  const { api, el, fmtEur, fmtDate, maskAccount, initials, requireUser, wireLogout, entryLabel, toast } = Bank;

  const user = await requireUser('user');
  if (!user) return;
  wireLogout(document.getElementById('logoutBtn'));

  const txList = document.getElementById('txList');
  const txEmpty = document.getElementById('txEmpty');
  const viewAll = document.getElementById('viewAll');
  let entries = [];

  function renderEntries(list) {
    txList.replaceChildren();
    txEmpty.hidden = list.length > 0;
    for (const e of list) {
      const label = entryLabel(e);
      const incoming = e.amount_cents > 0;
      txList.append(
        el('div', { class: 'tx' + (e.is_reversed ? ' reversed' : '') },
          el('div', { class: 'tx-icon ' + (incoming ? 'in' : 'out'), 'aria-hidden': 'true', text: incoming ? '↙' : '↗' }),
          el('div', { class: 'tx-info' },
            el('p', { class: 'tx-title', text: label.title }),
            label.sub ? el('p', { class: 'tx-sub', text: label.sub }) : null,
            el('p', { class: 'tx-sub', text: fmtDate(e.created_at) + (e.is_reversed ? ' · reversed' : '') }),
          ),
          el('div', { class: 'tx-amount ' + (incoming ? 'in' : 'out'), text: (incoming ? '+' : '') + fmtEur(e.amount_cents) }),
        ),
      );
    }
  }

  try {
    const d = await api('GET', '/api/dashboard');
    document.getElementById('ownerName').textContent = d.user.name;
    document.getElementById('topName').textContent = d.user.name;
    document.getElementById('ownerAccount').textContent = 'Account ' + maskAccount(d.user.account);
    document.getElementById('avatar').textContent = initials(d.user.name);
    document.getElementById('userChip').textContent = initials(d.user.name);
    document.getElementById('balance').textContent = fmtEur(d.balance_cents);
    document.getElementById('received').textContent = fmtEur(d.received_30d_cents);
    document.getElementById('sent').textContent = fmtEur(d.sent_30d_cents);
    document.getElementById('limitLeft').textContent = fmtEur(d.daily_remaining_cents);
    entries = d.entries;
    renderEntries(entries);
    viewAll.hidden = entries.length < 20;
  } catch (e) {
    toast(e.message, 'error');
  }

  async function loadAll() {
    const d = await api('GET', '/api/transactions?limit=500');
    entries = d.entries;
    return entries;
  }

  viewAll.addEventListener('click', async () => {
    try {
      renderEntries(await loadAll());
      viewAll.hidden = true;
    } catch (e) { toast(e.message, 'error'); }
  });

  document.getElementById('csvBtn').addEventListener('click', async () => {
    try {
      const all = await loadAll();
      const esc = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running text as formulas
        return '"' + s.replace(/"/g, '""') + '"';
      };
      const rows = [['Date', 'Type', 'Counterparty', 'Reference', 'Amount EUR', 'Ref ID']];
      for (const e of all) {
        rows.push([
          new Date(e.created_at * 1000).toISOString(), e.kind, e.counterparty_name || '',
          e.description, (e.amount_cents / 100).toFixed(2), e.ref,
        ]);
      }
      const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
      const a = el('a', { href: url, download: 'statement.csv' });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'error'); }
  });
})();
