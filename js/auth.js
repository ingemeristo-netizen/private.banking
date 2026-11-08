// js/auth.js — sign-in page. All checks happen in the data layer; this only calls the API.
(function () {
  'use strict';
  const { api, applyConfig } = Bank;

  const form = document.getElementById('loginForm');
  const errorBox = document.getElementById('loginError');
  const button = document.getElementById('loginBtn');
  const goHome = (user) => location.replace(user.role === 'admin' ? 'admin.html' : 'dashboard.html');

  // Brand name for the page, and skip the form if a valid session already exists.
  api('GET', '/api/config').then(applyConfig).catch(() => applyConfig({ brand: 'Bank' }));
  api('GET', '/api/me').then((d) => goHome(d.user)).catch(() => { /* not signed in */ });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    const account = document.getElementById('account').value.trim();
    const password = document.getElementById('password').value;
    if (!account || !password) {
      errorBox.textContent = 'Please fill in both fields.';
      errorBox.hidden = false;
      return;
    }

    button.disabled = true;
    try {
      const data = await api('POST', '/api/login', { account, password });
      goHome(data.user);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  });
})();
