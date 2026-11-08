// js/api.js — shared helpers for every page (loaded before the page script).
// api() talks to the local data layer (js/store.js) instead of a server.
(function () {
  'use strict';

  async function api(method, path, body) {
    await new Promise((resolve) => setTimeout(resolve, 25)); // keep the same async flow as a network call
    try {
      return BankStore.request(method, path, body);
    } catch (e) {
      throw e.status ? e : { status: 500, code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
    }
  }

  // Safe DOM builder: text is always inserted as text, never as HTML.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const eurFormat = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
  const fmtEur = (cents) => eurFormat.format(cents / 100);
  const fmtDate = (ts) =>
    new Date(ts * 1000).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  const groupAccount = (n) => String(n).replace(/(.{4})(?=.)/g, '$1 ');
  const maskAccount = (n) => '•••• ' + String(n).slice(-4);
  const initials = (name) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const amountLooksValid = (s) => /^\d{1,10}([.,]\d{1,2})?$/.test(String(s).trim());

  function applyConfig(cfg) {
    const brand = (cfg && cfg.brand) || 'Bank';
    document.querySelectorAll('[data-brand]').forEach((n) => { n.textContent = brand; });
    document.querySelectorAll('[data-brand-mark]').forEach((n) => { n.textContent = brand[0].toUpperCase(); });
    const page = document.body.dataset.title || '';
    document.title = page ? brand + ' — ' + page : brand;
  }

  async function requireUser(role) {
    try {
      const data = await api('GET', '/api/me');
      applyConfig(data.config);
      if (data.user.role !== role) {
        location.replace(data.user.role === 'admin' ? 'admin.html' : 'dashboard.html');
        return null;
      }
      return data.user;
    } catch (e) {
      if (e.status === 401) { location.replace('index.html'); return null; }
      toast(e.message, 'error');
      return null;
    }
  }

  function wireLogout(button) {
    if (!button) return;
    button.addEventListener('click', async () => {
      try { await api('POST', '/api/logout', {}); } catch (e) { /* ignore */ }
      location.replace('index.html');
    });
  }

  // How a ledger entry is displayed (used by customer and admin pages)
  function entryLabel(e) {
    const who = e.counterparty_name || '';
    switch (e.kind) {
      case 'transfer_out': return { title: 'Transfer · ' + who, sub: e.description };
      case 'transfer_in': return { title: 'Incoming · ' + who, sub: e.description };
      case 'adjustment': return { title: 'Adjustment by administrator', sub: e.description };
      case 'reversal': return { title: 'Reversal' + (who ? ' · ' + who : ''), sub: e.description };
      case 'opening': return { title: 'Opening balance', sub: '' };
      default: return { title: e.kind, sub: e.description };
    }
  }

  let toastTimer = null;
  function toast(message, kind) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const node = el('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), role: 'status', text: message });
    document.body.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 3500);
  }

  window.Bank = {
    api, el, fmtEur, fmtDate, groupAccount, maskAccount, initials,
    amountLooksValid, applyConfig, requireUser, wireLogout, entryLabel, toast,
  };
})();
