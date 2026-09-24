#!/usr/bin/env python3
"""Legg til (eller oppdater) én lokal administrator i private/admin.json uten å røre de andre.

    python3 add_admin.py andreas                       # spør etter passordet
    KONFACTION_ADMIN_PASSWORD='...' python3 add_admin.py andreas

Passordet må være det samme som de eksisterende brukerne har; skriptet sjekker det mot dem,
så en skrivefeil ikke gir den nye brukeren et annet passord. Bruk --new-password for å hoppe over sjekken.
Gjelder bare lokal kjøring (server.py). Cloudflare får brukerne fra setup_admin_cloudflare.py.
"""
from getpass import getpass
from pathlib import Path
import argparse, hashlib, hmac, json, os, secrets

parser = argparse.ArgumentParser()
parser.add_argument('username')
parser.add_argument('--new-password', action='store_true', help='ikke krev at passordet er likt de andre brukernes')
args = parser.parse_args()

path = Path(os.environ.get('KONFACTION_DATA', Path(__file__).resolve().parent / 'private')) / 'admin.json'
cfg = json.loads(path.read_text())
users = cfg['users'] if 'users' in cfg else [cfg]
scrypt = lambda pw, salt: hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

password = os.environ.get('KONFACTION_ADMIN_PASSWORD') or getpass('Passord (samme som de andre adminene): ')
if not args.new_password:
    same = [u['username'] for u in users if u['username'].casefold() != args.username.casefold() and hmac.compare_digest(scrypt(password, u['salt']), u['hash'])]
    if not same:
        raise SystemExit('Passordet stemmer ikke med noen av de eksisterende adminene. Ingenting er endret.')
    print(f'Passordet stemmer med: {", ".join(same)}')

salt = secrets.token_hex(16)
users = [u for u in users if u['username'].casefold() != args.username.casefold()]
users.append(dict(username=args.username, salt=salt, hash=scrypt(password, salt)))
path.write_text(json.dumps(dict(users=users)))
path.chmod(0o600)
print(f'{args.username} kan nå logge inn lokalt. (Ingen omstart nødvendig.)')
