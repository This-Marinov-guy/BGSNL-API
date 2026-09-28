#!/usr/bin/env python3
"""Record BGSNL API worker RSS without logging PM2 environment variables."""

import json
import subprocess
from datetime import datetime, timezone


processes = json.loads(
    subprocess.check_output(["docker", "exec", "bgsnl-api", "pm2", "jlist"], text=True)
)
workers = [
    {
        "id": process["pm_id"],
        "rssBytes": process["monit"]["memory"],
        "limitBytes": process["pm2_env"].get("max_memory_restart"),
    }
    for process in processes
    if process.get("name") == "BGSNL-API"
]
if not workers:
    raise SystemExit("No BGSNL API workers found")

print(
    json.dumps(
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "workers": workers,
            "maxWorkerRssBytes": max(worker["rssBytes"] for worker in workers),
        },
        separators=(",", ":"),
    )
)
