#!/usr/bin/env python3
"""Create the private admin file (one or more users) without putting credentials into source.

    python3 setup_admin.py                          # én bruker «admin»
    python3 setup_admin.py --users daniel,eskil,ida # flere brukere, samme passord
Passordet oppgis interaktivt (eller med --password / miljøvariabelen KONFACTION_ADMIN_PASSWORD).
"""
from getpass import getpass
from pathlib import Path
import argparse, hashlib, json, secrets, os

parser = argparse.ArgumentParser()
parser.add_argument('--users', default='daniel,eskil,ida,lars,martin,andreas,admin1,admin2,admin3,camilla', help='kommaseparert liste med brukernavn')
parser.add_argument('--password', default=os.environ.get('KONFACTION_ADMIN_PASSWORD', ''), help='passord for alle brukerne (ellers spørres du)')
args = parser.parse_args()

root = Path(os.environ.get('KONFACTION_DATA', Path(__file__).resolve().parent / 'private')); root.mkdir(parents=True, exist_ok=True)
names = [n.strip() for n in args.users.split(',') if n.strip()] or [input('Brukernavn [admin]: ').strip() or 'admin']
if len({n.casefold() for n in names}) != len(names):
    raise SystemExit('Brukernavnene må være ulike (store og små bokstaver regnes som like).')
password = args.password
if not password:
    password = getpass('Passord (minst 12 tegn): ')
    if password != getpass('Gjenta passord: '):
        raise SystemExit('Passordene er ikke like.')
if len(password) < 12:
    raise SystemExit('Passordet må ha minst 12 tegn.')

users = []
for name in names:
    salt = secrets.token_hex(16)
    users.append(dict(username=name, salt=salt, hash=hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()))
p = root / 'admin.json'
p.write_text(json.dumps(dict(users=users)))
p.chmod(0o600)
print(f'{len(users)} administrator(er) er klare: {", ".join(names)}. Start serveren på nytt for å avslutte eventuelle gamle økter.')
