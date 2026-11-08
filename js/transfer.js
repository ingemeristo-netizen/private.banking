// js/transfer.js — the data layer decides whether a transfer goes through and what the message says.
(async function () {
  'use strict';
  const { api, fmtEur, amountLooksValid, requireUser } = Bank;

  const user = await requireUser('user');
  if (!user) return;

  const form = document.getElementById('transferForm');
  const submitBtn = document.getElementById('submitBtn');
  const dialog = document.getElementById('resultDialog');
  const icon = document.getElementById('resultIcon');
  const title = document.getElementById('resultTitle');
  const text = document.getElementById('resultText');

  try {
    const d = await api('GET', '/api/dashboard');
    document.getElementById('limitsNote').textContent =
      'Per-transfer limit ' + fmtEur(d.single_limit_cents) + ' · remaining today ' + fmtEur(d.daily_remaining_cents) +
      ' · your balance ' + fmtEur(d.balance_cents);
  } catch (e) { /* the note is optional */ }

  function show(kind, heading, message) {
    icon.className = 'result-icon ' + kind;
    icon.textContent = kind === 'ok' ? '✓' : '!';
    title.textContent = heading;
    text.textContent = message;
    dialog.showModal();
  }

  document.getElementById('closeBtn').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const recipient = document.getElementById('recipient').value.trim();
    const amount = document.getElementById('amount').value.trim();
    const reference = document.getElementById('reference').value.trim();

    if (!recipient) return show('error', 'Transfer declined', 'Please enter the recipient account number.');
    if (!amountLooksValid(amount)) return show('error', 'Transfer declined', 'Please enter a valid amount (for example 125.50).');

    submitBtn.disabled = true;
    try {
      const r = await api('POST', '/api/transfer', { recipient_account: recipient, amount, reference });
      show('ok', 'Transfer completed',
        fmtEur(r.amount_cents) + ' sent to ' + r.recipient_name + '. New balance: ' + fmtEur(r.balance_cents) + '.');
      form.reset();
    } catch (err) {
      if (err.status === 401) return location.replace('index.html');
      show('error', 'Transfer declined', err.message); // text comes from the admin-editable message templates
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
