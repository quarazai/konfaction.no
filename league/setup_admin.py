#!/usr/bin/env python3
"""Create the private admin password hash without putting credentials into source."""
from getpass import getpass
from pathlib import Path
import hashlib,json,secrets,os
root=Path(os.environ.get('KONFACTION_DATA',Path(__file__).resolve().parent/'private'));root.mkdir(parents=True,exist_ok=True)
username=input('Brukernavn [admin]: ').strip() or 'admin'
password=getpass('Passord (minst 12 tegn): ')
if len(password)<12:raise SystemExit('Passordet må ha minst 12 tegn.')
if password!=getpass('Gjenta passord: '):raise SystemExit('Passordene er ikke like.')
salt=secrets.token_hex(16);p=root/'admin.json';p.write_text(json.dumps(dict(username=username,salt=salt,hash=hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex())));p.chmod(0o600)
print('Administrator er klar. Start serveren på nytt for å avslutte eventuelle gamle økter.')
