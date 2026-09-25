#!/usr/bin/env python3
"""Generate the Cloudflare Worker's admin credentials + session secret.

Prints `wrangler secret put` commands — it never writes credentials to disk.
Uses PBKDF2 (not server.py's scrypt) because Workers' Web Crypto has no
scrypt and this avoids pulling in nodejs_compat for one hash function.
"""
from getpass import getpass
import argparse, base64, hashlib, json, os, secrets

# Cloudflare gratisplan: 10 ms CPU per forespørsel. 5 000 runder ≈ 3 ms PBKDF2 (målt i Node; 10 000 ≈ 6 ms er for tett på grensen).
# Hver bruker lagrer sitt eget antall («iter»), så worker.js leser det derfra.
DEFAULT_ITERATIONS = 5000
DEFAULT_USERS = "daniel,eskil,ida,lars,martin,andreas,admin1,admin2,admin3,camilla"

parser = argparse.ArgumentParser()
parser.add_argument("--users", default=DEFAULT_USERS, help=f"kommaseparert liste med brukernavn (standard: {DEFAULT_USERS})")
parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS, help="PBKDF2-runder (standard 5000 holder innloggingen under 10 ms CPU på gratisplanen; bruk 100000+ bare på betalt plan)")
parser.add_argument("--password", default=os.environ.get("KONFACTION_ADMIN_PASSWORD", ""), help="passord for alle brukerne (ellers spørres du)")
parser.add_argument("--dev-vars", action="store_true", help="skriv til .dev.vars for lokal kjøring (wrangler dev) i stedet for å skrive ut kommandoer")
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

if args.dev_vars:
    # Bare for lokal kjøring. .dev.vars ligger i .gitignore og skal aldri på GitHub.
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".dev.vars"), "w") as f:
        f.write(f"SESSION_SECRET={session_secret}\nADMIN_USERS='{json.dumps(users, separators=(',', ':'))}'\n")
    # Passordet i klartekst, bare på denne maskinen (ligger i .gitignore), så det ikke glemmes.
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "LOKAL-INNLOGGING.txt"), "w") as f:
        f.write("Lokal admininnlogging (bare for localhost / lokalt nett, ikke Cloudflare)\n\n"
                f"Brukernavn: {', '.join(names)}\nPassord: {password}\n\nPassord på forsiden: siuuuuuuu\n")
    print("Lagret lokal admininnlogging i .dev.vars og LOKAL-INNLOGGING.txt (brukere: " + ", ".join(names) + ").")
    raise SystemExit(0)

print("\nKjør disse to (fra finales/, etter `wrangler login`, `wrangler d1 create konfaction` og `wrangler deploy`).")
print("Wrangler spør etter verdien uten å vise den — lim inn det som står under hver kommando:\n")
print("npx wrangler secret put ADMIN_USERS")
print(json.dumps(users, separators=(",", ":")))
print()
print("npx wrangler secret put SESSION_SECRET")
print(session_secret)
