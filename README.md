# PayDo — Online Banking

Client-side online banking: customer area, transfers between accounts and an
administrator console. Pure HTML/CSS/JavaScript — no build step, no server,
no dependencies. All data is stored locally in the browser (localStorage).

## Run

Open `index.html` in a browser, or deploy the folder to any static host
(GitHub Pages, Netlify, Vercel…). For GitHub Pages: push the repository,
then enable Pages in **Settings → Pages** with the root folder as the source.

Sign-in page: `index.html` · Customer dashboard: `dashboard.html` ·
New transfer: `transfer.html` · Administrator console: `admin.html`.

## Accounts (created on first launch)

| Role | Name | Account | Password |
|------|------|---------|----------|
| Administrator | Elena Marsh | 7701 2345 8901 | `Tundra-4821-Marsh` |
| Customer | Alexander Volkov | 4821 9900 7312 | `Sable-9142-Volkov` |
| Customer | Maria Rossi | 9053 4417 2288 | `Cobalt-5520-Rossi` |

To wipe all data and start over, run `localStorage.clear()` in the browser
console and reload the page.

## What the administrator can do (`admin.html`)

- Create customers, rename them, block/unblock, reset passwords.
- Post a **balance adjustment** (positive or negative) with a mandatory reason.
  It appears in the customer's history as "Adjustment by administrator".
- **Reverse** a transfer or adjustment (adds a counter-entry; both sides of
  a transfer are reversed).
- Edit the **text of every transfer error message** (with placeholders like
  `{limit}`, `{balance}`).
- Change transfer limits (per transfer, per rolling 24 hours).
- Read the **audit log** of every administrative action.

## Design rules

- Balances are never stored; they are the sum of an append-only ledger.
  Existing entries are never edited or deleted. Corrections are new entries.
- Error messages are tied to real checks (insufficient funds, limits, unknown
  recipient…). A transfer is declined only when one of those checks fails.
- Passwords are stored salted and hashed, sessions expire, login attempts are
  rate-limited, and every permission check runs in the data layer.

## Customise

- Product name: `js/config.js` (variable `BRAND`) — applied everywhere.
- Initial customers, balances and history: `js/store.js`, function `seed()`.
- Colours and theme: CSS variables at the top of `css/style.css`.

## Files

`index.html` sign in · `dashboard.html` customer area · `transfer.html` new
transfer · `admin.html` administrator console · `css/style.css` theme ·
`js/config.js` product name · `js/store.js` data layer (accounts, ledger,
sessions, audit, limits, message templates) · `js/api.js` shared helpers ·
`js/auth.js`, `js/dashboard.js`, `js/transfer.js`, `js/admin.js` page logic.
