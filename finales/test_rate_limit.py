#!/usr/bin/env python3
"""Self-check for state_rate_limited() in server.py. Its twin in worker.js
has the same check in test_rate_limit.mjs."""
import importlib.util, sys

spec = importlib.util.spec_from_file_location("server", "server.py")
server = importlib.util.module_from_spec(spec)
sys.argv = ["server.py"]
spec.loader.exec_module(server)

total = server.STATE_LIMIT_PER_MIN + 5
blocked = sum(1 for _ in range(total) if server.state_rate_limited("1.2.3.4"))
assert blocked == 5, f"expected 5 blocked ({total}-{server.STATE_LIMIT_PER_MIN}), got {blocked}"
assert not server.state_rate_limited("9.9.9.9"), "a fresh IP must not be affected by another IP's hits"
print("OK")
