#!/usr/bin/env python3
"""Test banking template: static site + JSON API. Standard library only.

Run:   python3 server.py
Reset: python3 server.py --reset-admin     (prints a new admin password)

Design rules
  * Balances are never stored: they are the sum of the append-only ledger.
  * Ledger rows can't be edited or deleted (SQLite triggers enforce it).
    Mistakes are fixed with new entries (adjustment / reversal).
  * Every admin action is written to the audit log.
  * All permission checks happen here on the server, not in the browser.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BANK_DB", ROOT / "data" / "bank.db"))
HOST = os.environ.get("BANK_HOST", "127.0.0.1")
PORT = int(os.environ.get("BANK_PORT", "8000"))
BRAND = os.environ.get("BANK_BRAND", "PayDo")  # rename the whole site here
SECURE_COOKIES = os.environ.get("BANK_SECURE_COOKIES") == "1"  # set when served over HTTPS
SESSION_TTL = 8 * 3600
MAX_BODY = 64 * 1024
MAX_AMOUNT_CENTS = 1_000_000_000_00  # 1 billion EUR, sanity cap

# --------------------------------------------------------------------------
# Defaults
# --------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "single_limit_cents": 50_000_00,   # per transfer
    "daily_limit_cents": 100_000_00,   # rolling 24 hours
}

# code -> (text, description, placeholders)
DEFAULT_MESSAGES = {
    "INSUFFICIENT_FUNDS": (
        "Insufficient funds on the account. Available balance: {balance}.",
        "The amount is larger than the sender's balance.",
        ["balance"],
    ),
    "SINGLE_LIMIT_EXCEEDED": (
        "The amount exceeds the per-transfer limit of {limit}.",
        "The amount is above the single-transfer limit.",
        ["limit"],
    ),
    "DAILY_LIMIT_EXCEEDED": (
        "The daily transfer limit of {limit} would be exceeded. Remaining today: {remaining}.",
        "Transfers in the last 24 hours plus this one are above the daily limit.",
        ["limit", "remaining"],
    ),
    "RECIPIENT_NOT_FOUND": (
        "The recipient account was not found. Please check the account number.",
        "No active customer account has this number.",
        [],
    ),
    "RECIPIENT_BLOCKED": (
        "The recipient account cannot receive transfers at the moment.",
        "The recipient account is blocked.",
        [],
    ),
    "ACCOUNT_BLOCKED": (
        "Your account is blocked. Please contact support.",
        "The sender (or the user logging in) is blocked.",
        [],
    ),
    "SAME_ACCOUNT": (
        "You cannot transfer funds to your own account.",
        "Sender and recipient are the same account.",
        [],
    ),
    "INVALID_AMOUNT": (
        "Please enter a valid amount (for example 125.50).",
        "The amount is missing, zero, negative or has too many decimals.",
        [],
    ),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked')),
  pw_salt BLOB NOT NULL,
  pw_hash BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('opening','transfer_out','transfer_in','adjustment','reversal')),
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  counterparty_id INTEGER REFERENCES users(id),
  ref TEXT NOT NULL,
  reverses_id INTEGER REFERENCES ledger(id),
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  code TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
"""

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def now():
    return int(time.time())


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)  # manual transactions
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        conn.close()


def scrypt(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def hash_password(password):
    salt = secrets.token_bytes(16)
    return salt, scrypt(password, salt)


def verify_password(password, salt, expected):
    return hmac.compare_digest(scrypt(password, salt), expected)


DUMMY_SALT, DUMMY_HASH = hash_password("timing-equaliser")


def check_password_rules(password):
    if not isinstance(password, str) or not (8 <= len(password) <= 200):
        raise ApiError(400, "WEAK_PASSWORD", "Password must be between 8 and 200 characters.")


def new_password():
    return secrets.token_urlsafe(9)  # 12 readable characters


def normalize_account(value):
    value = re.sub(r"[\s-]", "", str(value or "")).upper()
    return value if re.fullmatch(r"[0-9A-Z]{6,24}", value) else ""


def new_account_number(conn):
    while True:
        number = "".join(str(secrets.randbelow(10)) for _ in range(12))
        if not conn.execute("SELECT 1 FROM users WHERE account=?", (number,)).fetchone():
            return number


def group_account(number):
    return " ".join(number[i:i + 4] for i in range(0, len(number), 4))


def clean_text(value, max_len, min_len=0, field="Text"):
    value = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).strip()
    if not (min_len <= len(value) <= max_len):
        raise ApiError(400, "INVALID_INPUT", f"{field} must be {min_len}-{max_len} characters.")
    return value


def parse_amount(value, signed=False):
    """'1234.50' -> 123450 cents. Raises ValueError on anything odd."""
    text = str(value if value is not None else "").strip().replace(",", ".")
    pattern = r"[+-]?\d{1,10}(\.\d{1,2})?" if signed else r"\d{1,10}(\.\d{1,2})?"
    if not re.fullmatch(pattern, text):
        raise ValueError("bad amount")
    try:
        cents = int((Decimal(text) * 100).to_integral_value())
    except InvalidOperation:
        raise ValueError("bad amount")
    if cents == 0 or abs(cents) > MAX_AMOUNT_CENTS:
        raise ValueError("bad amount")
    return cents


def eur(cents):
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return f"{sign}€{whole:,}.{frac:02d}"


def get_settings(conn):
    rows = {r["key"]: int(r["value"]) for r in conn.execute("SELECT key, value FROM settings")}
    return {k: rows.get(k, v) for k, v in DEFAULT_SETTINGS.items()}


def render_message(conn, code, values=None):
    row = conn.execute("SELECT text FROM messages WHERE code=?", (code,)).fetchone()
    text = row["text"] if row else DEFAULT_MESSAGES.get(code, ("Request declined.",))[0]
    for key, val in (values or {}).items():
        text = text.replace("{" + key + "}", str(val))
    return text


def balance_of(conn, user_id):
    return conn.execute(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE user_id=?", (user_id,)
    ).fetchone()[0]


def audit(ctx_or_conn, actor_id, action, target="", details=None, ip=""):
    conn = getattr(ctx_or_conn, "conn", ctx_or_conn)
    conn.execute(
        "INSERT INTO audit(actor_id, action, target, details, ip, created_at) VALUES(?,?,?,?,?,?)",
        (actor_id, action, str(target), json.dumps(details or {}, ensure_ascii=False), ip, now()),
    )


def entry_dict(row):
    return {
        "id": row["id"],
        "kind": row["kind"],
        "amount_cents": row["amount_cents"],
        "description": row["description"],
        "counterparty_name": row["counterparty_name"],
        "ref": row["ref"],
        "created_at": row["created_at"],
        "is_reversed": bool(row["is_reversed"]),
    }


LEDGER_SELECT = """
SELECT l.id, l.kind, l.amount_cents, l.description, l.ref, l.created_at,
       c.name AS counterparty_name,
       EXISTS(SELECT 1 FROM ledger r WHERE r.reverses_id = l.id) AS is_reversed
FROM ledger l LEFT JOIN users c ON c.id = l.counterparty_id
"""


def user_entries(conn, user_id, limit):
    rows = conn.execute(LEDGER_SELECT + " WHERE l.user_id=? ORDER BY l.id DESC LIMIT ?", (user_id, limit))
    return [entry_dict(r) for r in rows]


# Login throttling (in memory; resets on restart)
_fail_lock = threading.Lock()
_fails = {}
FAIL_WINDOW = 900


def throttle_check(key, limit):
    t = time.time()
    with _fail_lock:
        recent = [x for x in _fails.get(key, []) if t - x < FAIL_WINDOW]
        _fails[key] = recent
        if len(recent) >= limit:
            raise ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed attempts. Please try again in a few minutes.")


def throttle_fail(key):
    with _fail_lock:
        _fails.setdefault(key, []).append(time.time())


# --------------------------------------------------------------------------
# Database setup
# --------------------------------------------------------------------------


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)", (key, str(value)))
        for code, (text, desc, _) in DEFAULT_MESSAGES.items():
            conn.execute("INSERT OR IGNORE INTO messages(code, text, description) VALUES(?,?,?)", (code, text, desc))


def create_user(conn, name, role="user", password=None):
    password = password or new_password()
    salt, digest = hash_password(password)
    account = new_account_number(conn)
    cur = conn.execute(
        "INSERT INTO users(account, name, role, pw_salt, pw_hash, created_at) VALUES(?,?,?,?,?,?)",
        (account, name, role, salt, digest, now()),
    )
    return cur.lastrowid, account, password


def seed_if_empty():
    with connect() as conn:
        if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            return
        conn.execute("BEGIN IMMEDIATE")
        created = []
        admin_id, account, pw = create_user(conn, "Administrator", role="admin")
        created.append(("ADMIN", "Administrator", account, pw))
        for name, opening in (("Alexander Volkov", 248_750_00), ("Maria Rossi", 10_000_00)):
            uid, account, pw = create_user(conn, name)
            conn.execute(
                "INSERT INTO ledger(user_id, kind, amount_cents, description, ref, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (uid, "opening", opening, "Test data", "open-" + secrets.token_hex(6), now()),
            )
            created.append(("TEST USER", name, account, pw))
        audit(conn, None, "seed", "", {"users": len(created)})
        conn.execute("COMMIT")
    print("\nFirst start: created these accounts. Passwords are shown ONLY now.\n")
    for role, name, account, pw in created:
        print(f"  {role:<9} {name:<18} account {group_account(account)}   password {pw}")
    print()


def reset_admin():
    init_db()
    with connect() as conn:
        row = conn.execute("SELECT id, account FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
        if not row:
            print("No admin account exists yet. Start the server once to create it.")
            return
        password = new_password()
        salt, digest = hash_password(password)
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE users SET pw_salt=?, pw_hash=?, status='active' WHERE id=?", (salt, digest, row["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))
        audit(conn, None, "admin_password_reset_cli", row["account"])
        conn.execute("COMMIT")
    print(f"Admin account {group_account(row['account'])} new password: {password}")


# --------------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------------

ROUTES = []


def route(method, pattern, auth="any"):
    """auth: None = public, 'any' = logged in, 'user' = customer, 'admin' = administrator."""

    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn, auth))
        return fn

    return deco


class Ctx:
    def __init__(self, conn, user, ip):
        self.conn, self.user, self.ip = conn, user, ip
        self.headers = []  # extra response headers


def public_user(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "account": row["account"],
        "role": row["role"],
        "status": row["status"],
    }


# ---- public / session -----------------------------------------------------


@route("GET", "/api/config", auth=None)
def get_config(ctx, m, q, body):
    return {"brand": BRAND, "test_banner": True}


@route("POST", "/api/login", auth=None)
def login(ctx, m, q, body):
    account = normalize_account(body.get("account"))
    password = str(body.get("password") or "")
    key = f"{ctx.ip}|{account}"
    throttle_check(key, 5)
    throttle_check(ctx.ip, 30)
    user = ctx.conn.execute("SELECT * FROM users WHERE account=?", (account,)).fetchone() if account else None
    ok = verify_password(password, user["pw_salt"], user["pw_hash"]) if user else (
        verify_password(password, DUMMY_SALT, DUMMY_HASH) and False
    )
    if not ok:
        throttle_fail(key)
        throttle_fail(ctx.ip)
        audit(ctx, None, "login_failed", account[-4:], ip=ctx.ip)
        raise ApiError(401, "INVALID_CREDENTIALS", "Invalid account number or password.")
    if user["status"] != "active":
        raise ApiError(403, "ACCOUNT_BLOCKED", render_message(ctx.conn, "ACCOUNT_BLOCKED"))

    token = secrets.token_urlsafe(32)
    ctx.conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    ctx.conn.execute(
        "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)",
        (hashlib.sha256(token.encode()).hexdigest(), user["id"], now(), now() + SESSION_TTL),
    )
    if user["role"] == "admin":
        audit(ctx, user["id"], "login", "", ip=ctx.ip)
    cookie = f"sid={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}"
    if SECURE_COOKIES:
        cookie += "; Secure"
    ctx.headers.append(("Set-Cookie", cookie))
    return {"user": public_user(user)}


@route("POST", "/api/logout", auth=None)
def logout(ctx, m, q, body):
    token = ctx.cookie_token if hasattr(ctx, "cookie_token") else None
    if token:
        ctx.conn.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    ctx.headers.append(("Set-Cookie", "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"))
    return {"ok": True}


@route("GET", "/api/me")
def me(ctx, m, q, body):
    return {"user": public_user(ctx.user), "config": {"brand": BRAND, "test_banner": True}}


# ---- customer -------------------------------------------------------------


@route("GET", "/api/dashboard", auth="user")
def dashboard(ctx, m, q, body):
    conn, uid = ctx.conn, ctx.user["id"]
    settings = get_settings(conn)
    since_30d = now() - 30 * 86400
    since_24h = now() - 86400
    received = conn.execute(
        "SELECT COALESCE(SUM(amount_cents),0) FROM ledger WHERE user_id=? AND kind='transfer_in' AND created_at>=?",
        (uid, since_30d),
    ).fetchone()[0]
    sent = -conn.execute(
        "SELECT COALESCE(SUM(amount_cents),0) FROM ledger WHERE user_id=? AND kind='transfer_out' AND created_at>=?",
        (uid, since_30d),
    ).fetchone()[0]
    used_24h = -conn.execute(
        "SELECT COALESCE(SUM(amount_cents),0) FROM ledger WHERE user_id=? AND kind='transfer_out' AND created_at>=?",
        (uid, since_24h),
    ).fetchone()[0]
    return {
        "user": public_user(ctx.user),
        "balance_cents": balance_of(conn, uid),
        "received_30d_cents": received,
        "sent_30d_cents": sent,
        "daily_remaining_cents": max(0, settings["daily_limit_cents"] - used_24h),
        "single_limit_cents": settings["single_limit_cents"],
        "daily_limit_cents": settings["daily_limit_cents"],
        "entries": user_entries(conn, uid, 20),
    }


@route("GET", "/api/transactions", auth="user")
def transactions(ctx, m, q, body):
    try:
        limit = max(1, min(500, int(q.get("limit", ["200"])[0])))
    except ValueError:
        limit = 200
    return {"entries": user_entries(ctx.conn, ctx.user["id"], limit)}


@route("POST", "/api/transfer", auth="user")
def transfer(ctx, m, q, body):
    conn = ctx.conn
    recipient_acc = normalize_account(body.get("recipient_account"))
    reference = clean_text(body.get("reference", ""), 140, field="Reference")
    conn.execute("BEGIN IMMEDIATE")
    try:
        def fail(code, **values):
            raise ApiError(422, code, render_message(conn, code, values))

        try:
            cents = parse_amount(body.get("amount"))
        except ValueError:
            fail("INVALID_AMOUNT")

        sender = conn.execute("SELECT * FROM users WHERE id=?", (ctx.user["id"],)).fetchone()
        if sender["status"] != "active":
            fail("ACCOUNT_BLOCKED")
        recipient = (
            conn.execute("SELECT * FROM users WHERE account=? AND role='user'", (recipient_acc,)).fetchone()
            if recipient_acc else None
        )
        if not recipient:
            fail("RECIPIENT_NOT_FOUND")
        if recipient["id"] == sender["id"]:
            fail("SAME_ACCOUNT")
        if recipient["status"] != "active":
            fail("RECIPIENT_BLOCKED")

        settings = get_settings(conn)
        if cents > settings["single_limit_cents"]:
            fail("SINGLE_LIMIT_EXCEEDED", limit=eur(settings["single_limit_cents"]))
        used = -conn.execute(
            "SELECT COALESCE(SUM(amount_cents),0) FROM ledger WHERE user_id=? AND kind='transfer_out' AND created_at>=?",
            (sender["id"], now() - 86400),
        ).fetchone()[0]
        if used + cents > settings["daily_limit_cents"]:
            fail(
                "DAILY_LIMIT_EXCEEDED",
                limit=eur(settings["daily_limit_cents"]),
                remaining=eur(max(0, settings["daily_limit_cents"] - used)),
            )
        balance = balance_of(conn, sender["id"])
        if cents > balance:
            fail("INSUFFICIENT_FUNDS", balance=eur(balance))

        ref = "tx-" + secrets.token_hex(8)
        ts = now()
        for uid, other, kind, amount in (
            (sender["id"], recipient["id"], "transfer_out", -cents),
            (recipient["id"], sender["id"], "transfer_in", cents),
        ):
            conn.execute(
                "INSERT INTO ledger(user_id, kind, amount_cents, description, counterparty_id, ref, created_by, created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (uid, kind, amount, reference, other, ref, sender["id"], ts),
            )
        new_balance = balance - cents
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return {"ok": True, "ref": ref, "amount_cents": cents, "recipient_name": recipient["name"], "balance_cents": new_balance}


# ---- admin: users ---------------------------------------------------------


def target_user(conn, user_id):
    row = conn.execute("SELECT * FROM users WHERE id=? AND role='user'", (user_id,)).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Customer not found.")
    return row


@route("GET", "/api/admin/users", auth="admin")
def admin_users(ctx, m, q, body):
    rows = ctx.conn.execute(
        """SELECT u.id, u.account, u.name, u.status, u.created_at,
                  COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE user_id=u.id), 0) AS balance_cents
           FROM users u WHERE u.role='user' ORDER BY u.id"""
    )
    return {"users": [dict(r) for r in rows]}


@route("POST", "/api/admin/users", auth="admin")
def admin_create_user(ctx, m, q, body):
    name = clean_text(body.get("name"), 80, 2, "Name")
    password = body.get("password") or None
    if password:
        check_password_rules(password)
    ctx.conn.execute("BEGIN IMMEDIATE")
    uid, account, password = create_user(ctx.conn, name, password=password)
    audit(ctx, ctx.user["id"], "user_create", uid, {"name": name, "account": account}, ctx.ip)
    ctx.conn.execute("COMMIT")
    return {"id": uid, "account": account, "name": name, "password": password}


@route("PATCH", r"/api/admin/users/(\d+)", auth="admin")
def admin_update_user(ctx, m, q, body):
    conn = ctx.conn
    user = target_user(conn, int(m.group(1)))
    changes = {}
    if "name" in body:
        changes["name"] = clean_text(body["name"], 80, 2, "Name")
    if "status" in body:
        if body["status"] not in ("active", "blocked"):
            raise ApiError(400, "INVALID_INPUT", "Status must be 'active' or 'blocked'.")
        changes["status"] = body["status"]
    if not changes:
        raise ApiError(400, "INVALID_INPUT", "Nothing to change.")
    conn.execute("BEGIN IMMEDIATE")
    before = {k: user[k] for k in changes}
    for key, value in changes.items():
        conn.execute(f"UPDATE users SET {key}=? WHERE id=?", (value, user["id"]))  # keys are whitelisted above
    if changes.get("status") == "blocked":
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    audit(conn, ctx.user["id"], "user_update", user["id"], {"before": before, "after": changes}, ctx.ip)
    conn.execute("COMMIT")
    return {"ok": True}


@route("POST", r"/api/admin/users/(\d+)/password", auth="admin")
def admin_reset_password(ctx, m, q, body):
    conn = ctx.conn
    user = target_user(conn, int(m.group(1)))
    password = body.get("password") or new_password()
    check_password_rules(password)
    salt, digest = hash_password(password)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?", (salt, digest, user["id"]))
    conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    audit(conn, ctx.user["id"], "password_reset", user["id"], {}, ctx.ip)
    conn.execute("COMMIT")
    return {"password": password}


@route("GET", r"/api/admin/users/(\d+)/ledger", auth="admin")
def admin_user_ledger(ctx, m, q, body):
    user = target_user(ctx.conn, int(m.group(1)))
    return {
        "user": {"id": user["id"], "name": user["name"], "account": user["account"]},
        "balance_cents": balance_of(ctx.conn, user["id"]),
        "entries": user_entries(ctx.conn, user["id"], 300),
    }


# ---- admin: ledger corrections -------------------------------------------


@route("POST", "/api/admin/adjustments", auth="admin")
def admin_adjustment(ctx, m, q, body):
    conn = ctx.conn
    try:
        cents = parse_amount(body.get("amount"), signed=True)
    except ValueError:
        raise ApiError(400, "INVALID_AMOUNT", "Enter a non-zero amount such as 250.00 or -40.50.")
    reason = clean_text(body.get("reason"), 140, 5, "Reason")
    try:
        user_id = int(body.get("user_id"))
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_INPUT", "Choose a customer.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        user = target_user(conn, user_id)
        if balance_of(conn, user["id"]) + cents < 0:
            raise ApiError(409, "NEGATIVE_BALANCE", "This adjustment would make the balance negative.")
        ref = "adj-" + secrets.token_hex(8)
        conn.execute(
            "INSERT INTO ledger(user_id, kind, amount_cents, description, ref, created_by, created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (user["id"], "adjustment", cents, reason, ref, ctx.user["id"], now()),
        )
        audit(conn, ctx.user["id"], "adjustment", user["id"], {"amount_cents": cents, "reason": reason, "ref": ref}, ctx.ip)
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return {"ok": True, "ref": ref, "balance_cents": balance_of(conn, user["id"])}


@route("POST", "/api/admin/reversals", auth="admin")
def admin_reversal(ctx, m, q, body):
    conn = ctx.conn
    ref = str(body.get("ref") or "")
    reason = clean_text(body.get("reason"), 140, 5, "Reason")
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            """SELECT l.* FROM ledger l
               WHERE l.ref=? AND l.kind IN ('transfer_out','transfer_in','adjustment')
                 AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = l.id)""",
            (ref,),
        ).fetchall()
        if not rows:
            raise ApiError(409, "NOT_REVERSIBLE", "Nothing to reverse: unknown reference or already reversed.")
        deltas = {}
        for r in rows:
            deltas[r["user_id"]] = deltas.get(r["user_id"], 0) - r["amount_cents"]
        for uid, delta in deltas.items():
            if balance_of(conn, uid) + delta < 0:
                raise ApiError(409, "NEGATIVE_BALANCE", "Cannot reverse: an account would go below zero.")
        rev_ref = "rev-" + secrets.token_hex(8)
        for r in rows:
            conn.execute(
                "INSERT INTO ledger(user_id, kind, amount_cents, description, counterparty_id, ref, reverses_id, created_by, created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (r["user_id"], "reversal", -r["amount_cents"], f"Reversal of #{r['id']}: {reason}",
                 r["counterparty_id"], rev_ref, r["id"], ctx.user["id"], now()),
            )
        audit(conn, ctx.user["id"], "reversal", ref, {"entries": [r["id"] for r in rows], "reason": reason}, ctx.ip)
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return {"ok": True, "reversed": len(rows)}


# ---- admin: messages, limits, audit --------------------------------------


@route("GET", "/api/admin/messages", auth="admin")
def admin_messages(ctx, m, q, body):
    rows = ctx.conn.execute("SELECT code, text, description FROM messages ORDER BY code").fetchall()
    return {
        "messages": [
            {**dict(r), "placeholders": DEFAULT_MESSAGES.get(r["code"], ("", "", []))[2],
             "default": DEFAULT_MESSAGES.get(r["code"], ("",))[0]}
            for r in rows
        ]
    }


@route("PUT", "/api/admin/messages", auth="admin")
def admin_set_message(ctx, m, q, body):
    conn = ctx.conn
    code = str(body.get("code") or "")
    text = clean_text(body.get("text"), 300, 5, "Message")
    row = conn.execute("SELECT text FROM messages WHERE code=?", (code,)).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "Unknown message code.")
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE messages SET text=? WHERE code=?", (text, code))
    audit(conn, ctx.user["id"], "message_update", code, {"before": row["text"], "after": text}, ctx.ip)
    conn.execute("COMMIT")
    return {"ok": True}


@route("GET", "/api/admin/settings", auth="admin")
def admin_get_settings(ctx, m, q, body):
    return get_settings(ctx.conn)


@route("PUT", "/api/admin/settings", auth="admin")
def admin_set_settings(ctx, m, q, body):
    conn = ctx.conn
    try:
        single = parse_amount(body.get("single_limit"))
        daily = parse_amount(body.get("daily_limit"))
    except ValueError:
        raise ApiError(400, "INVALID_AMOUNT", "Enter limits as amounts such as 50000 or 50000.00.")
    if daily < single:
        raise ApiError(400, "INVALID_INPUT", "The daily limit cannot be lower than the per-transfer limit.")
    before = get_settings(conn)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE settings SET value=? WHERE key='single_limit_cents'", (str(single),))
    conn.execute("UPDATE settings SET value=? WHERE key='daily_limit_cents'", (str(daily),))
    audit(conn, ctx.user["id"], "settings_update", "limits",
          {"before": before, "after": {"single_limit_cents": single, "daily_limit_cents": daily}}, ctx.ip)
    conn.execute("COMMIT")
    return {"ok": True}


@route("GET", "/api/admin/audit", auth="admin")
def admin_audit(ctx, m, q, body):
    try:
        limit = max(1, min(500, int(q.get("limit", ["100"])[0])))
    except ValueError:
        limit = 100
    rows = ctx.conn.execute(
        """SELECT a.id, a.action, a.target, a.details, a.ip, a.created_at, u.name AS actor_name
           FROM audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return {"entries": [dict(r) for r in rows]}


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------

STATIC_TOP = {"index.html", "dashboard.html", "transfer.html", "admin.html"}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"


class Handler(BaseHTTPRequestHandler):
    server_version = "BankTemplate"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.client_address[0], fmt % args))

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api(method, parsed.path, parse_qs(parsed.query))
        elif method == "GET":
            self.serve_static(parsed.path)
        else:
            self.send_json(405, {"error": {"code": "METHOD_NOT_ALLOWED", "message": "Method not allowed."}})

    # ---- API
    def handle_api(self, method, path, query):
        try:
            if method != "GET":
                self.check_csrf()
            matched = None
            path_exists = False
            for r_method, pattern, fn, auth in ROUTES:
                m = pattern.match(path)
                if m:
                    path_exists = True
                    if r_method == method:
                        matched = (m, fn, auth)
                        break
            if not matched:
                raise ApiError(405 if path_exists else 404, "NOT_FOUND", "Not found.")
            m, fn, auth = matched
            body = self.read_json() if method in ("POST", "PUT", "PATCH") else {}
            with connect() as conn:
                ctx = Ctx(conn, None, self.client_address[0])
                ctx.cookie_token = self.cookie_token()
                if auth:
                    ctx.user = self.authenticate(conn, ctx.cookie_token)
                    if not ctx.user:
                        raise ApiError(401, "UNAUTHENTICATED", "Please sign in.")
                    if auth in ("user", "admin") and ctx.user["role"] != auth:
                        raise ApiError(403, "FORBIDDEN", "You do not have access to this action.")
                result = fn(ctx, m, query, body)
            self.send_json(200, result, ctx.headers)
        except ApiError as e:
            self.send_json(e.status, {"error": {"code": e.code, "message": e.message}})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": {"code": "SERVER_ERROR", "message": "Something went wrong on the server."}})

    def check_csrf(self):
        if self.headers.get("X-Requested-With") != "fetch":
            raise ApiError(403, "CSRF", "Missing request header.")
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            raise ApiError(403, "CSRF", "Cross-origin request blocked.")

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            raise ApiError(413, "TOO_LARGE", "Request body is too large.")
        if length == 0:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "BAD_JSON", "Request body must be valid JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "BAD_JSON", "Request body must be a JSON object.")
        return data

    def cookie_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            jar = SimpleCookie(raw)
        except Exception:
            return None
        return jar["sid"].value if "sid" in jar else None

    def authenticate(self, conn, token):
        if not token:
            return None
        return conn.execute(
            """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash=? AND s.expires_at > ? AND u.status='active'""",
            (hashlib.sha256(token.encode()).hexdigest(), now()),
        ).fetchone()

    # ---- responses
    def send_json(self, status, payload, extra_headers=()):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in extra_headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        allowed = rel in STATIC_TOP or (rel.startswith(("css/", "js/")) and ".." not in rel)
        full = (ROOT / rel).resolve()
        try:
            full.relative_to(ROOT)
        except ValueError:
            allowed = False
        if not allowed or not full.is_file():
            return self.send_json(404, {"error": {"code": "NOT_FOUND", "message": "Not found."}})
        data = full.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(full.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if full.suffix == ".html":
            self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(data)


def main():
    if "--reset-admin" in sys.argv:
        return reset_admin()
    init_db()
    seed_if_empty()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"{BRAND} test environment running at http://{HOST}:{PORT}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
