#!/usr/bin/env python3
"""Generate the Cloudflare Worker's admin credentials + session secret.

Prints `wrangler secret put` commands — it never writes credentials to disk.
Uses PBKDF2 (not server.py's scrypt) because Workers' Web Crypto has no
scrypt and this avoids pulling in nodejs_compat for one hash function.
"""
from getpass import getpass
import argparse, base64, hashlib, json, os, secrets, shlex

# Cloudflare gratisplan: 10 ms CPU per forespørsel. 10 000 runder ≈ 4–5 ms i workerd (god margin).
# Hver bruker lagrer sitt eget antall («iter»), så worker.js leser det derfra.
DEFAULT_ITERATIONS = 10000
DEFAULT_USERS = "daniel,eskil,ida,lars,martin,andreas,admin1,admin2,admin3,camilla"

parser = argparse.ArgumentParser()
parser.add_argument("--users", default=DEFAULT_USERS, help=f"kommaseparert liste med brukernavn (standard: {DEFAULT_USERS})")
parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS, help="PBKDF2-runder (standard 10000; bruk 100000+ bare på betalt plan)")
parser.add_argument("--password", default=os.environ.get("KONFACTION_ADMIN_PASSWORD", ""), help="passord for alle brukerne (ellers spørres du)")
args = parser.parse_args()

names = [n.strip() for n in args.users.split(",") if n.strip()] or [input("Brukernavn [admin]: ").strip() or "admin"]
if len({n.lower() for n in names}) != len(names):
    raise SystemExit("Brukernavnene må være ulike (store og små bokstaver regnes som like).")
password = args.password
if not password:
    password = getpass("Passord (minst 12 tegn): ")
    if password != getpass("Gjenta passord: "):
        raise SystemExit("Passordene er ikke like.")
if len(password) < 12:
    raise SystemExit("Passordet må ha minst 12 tegn.")

users = []
for name in names:
    salt = secrets.token_hex(16)
    users.append({"username": name, "salt": salt, "iter": args.iterations, "hash": hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), args.iterations).hex()})
session_secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")

print("\nKjør disse (fra finales/, etter `wrangler login` og `wrangler d1 create konfaction`):\n")
print(f"echo {shlex.quote(json.dumps(users, separators=(',', ':')))} | npx wrangler secret put ADMIN_USERS")
print(f"echo {session_secret} | npx wrangler secret put SESSION_SECRET")
