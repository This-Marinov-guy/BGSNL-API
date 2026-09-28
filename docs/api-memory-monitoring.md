# API worker memory

PM2 uses `BGSNL_API_MAX_MEMORY_RESTART` as the per-worker restart threshold,
defaulting to 1 GB. The previous 300 MB limit recycled healthy workers during
startup. The default is a safety ceiling; review observed memory before changing
it.

The VPS timer samples each PM2 worker's resident memory every five minutes.
It writes a small JSON summary to the system journal without logging PM2's
environment variables. Inspect recent samples with:

```sh
journalctl -u bgsnl-api-memory.service --since today -o cat
```

Inspect timer health with `systemctl status bgsnl-api-memory.timer`. Samples
record `maxWorkerRssBytes`, which is the largest worker RSS at that instant.
Compare samples over time to find the observed peak.

To install the sampler on a new VPS:

```sh
install -m 755 scripts/sample-api-memory.py /usr/local/sbin/bgsnl-api-memory-sample
install -m 644 ops/systemd/bgsnl-api-memory.service ops/systemd/bgsnl-api-memory.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bgsnl-api-memory.timer
```
