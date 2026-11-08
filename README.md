# Banking template (test environment)

A small online-banking template: customer area, transfers, and an administrator console.
It is a **test project with sample data only**. It has no connection to real payment systems.

## Run

Requires Python 3.9+ and nothing else (no packages to install).

```bash
python3 server.py
```

Open http://127.0.0.1:8000. On the first start the server creates an administrator and two test
customers and prints their account numbers and **random passwords once** in the console.
Lost the admin password? Run `python3 server.py --reset-admin`.

Settings (environment variables): `BANK_PORT`, `BANK_HOST`, `BANK_DB` (database path),
`BANK_BRAND` (site name, default `PayDo`), `BANK_SECURE_COOKIES=1` (set when serving over HTTPS).

To rename the product, run e.g. `BANK_BRAND="MyBank" python3 server.py`. The name is applied everywhere.

## What the administrator can do (`/admin.html`)

- Create customers, rename them, block/unblock, reset passwords.
- Post a **balance adjustment** (positive or negative) with a mandatory reason. It appears in the
  customer's history as "Adjustment by administrator".
- **Reverse** a transfer or adjustment (adds a counter-entry; both sides of a transfer are reversed).
- Edit the **text of every transfer error message** (with placeholders like `{limit}`, `{balance}`).
- Change transfer limits (per transfer, per rolling 24 hours).
- Read the **audit log** of every administrative action.

## Design rules

- Balances are never stored; they are the sum of an append-only ledger. Existing entries cannot be
  edited or deleted (enforced by database triggers). Corrections are new entries.
- Error messages are tied to real checks (insufficient funds, limits, unknown recipient...).
  A transfer is declined only when one of those checks fails.
- Passwords are hashed with scrypt, sessions are random server-side tokens in HttpOnly cookies,
  login attempts are rate-limited, and every permission check runs on the server.

## Before using this for anything real

This is a template, not a licensed financial product. A real service needs, at minimum: HTTPS,
a production database and backups, two-factor authentication, KYC/AML processes, regulatory
licensing, and a security review.

## Files

`server.py` backend and API · `index.html` sign in · `dashboard.html` customer area ·
`transfer.html` new transfer · `admin.html` administrator console · `css/style.css` theme ·
`js/` page scripts (`api.js` shared helpers).
