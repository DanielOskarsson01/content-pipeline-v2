# Hetzner Server Infrastructure

**Server:** `188.245.110.34`
**SSH alias:** `ssh hetzner` (configured in `~/.ssh/config`, `IdentityFile ~/.ssh/hetzner_key`)
**Last verified:** 2026-06-02

This document captures the systemd services, boot chain, self-healing layers, and recovery procedures for the Hetzner host that runs the Content Pipeline backend (skeleton repo `content-pipeline-v2`) plus the LinkedIn `profile-api` and other side services.

---

## Services running

| PM2 app | Mode | Purpose |
|---------|------|---------|
| `pipeline-api` | fork | Skeleton API (port 3001) |
| `stage-worker` | fork | BullMQ stage queue worker |
| `batch-worker` | fork | BullMQ batch queue worker (entity-level execution) |
| `profile-api` | fork | LinkedIn profile/job scraper (port 3847) — spawns Chrome on display `:1` |
| `meal-api` | fork | Weekly meal planner API (port 3002, "Pantry API"). Lives in `/var/www/meals-api`, script `index.js`. |

Display server + Chrome are NOT separate systemd services. `profile-api/server.js` spawns Chrome itself via `spawn()` with hardcoded:
- `DISPLAY: ":1"`
- `--no-sandbox --disable-gpu --remote-debugging-port=9222 --user-data-dir=/root/.config/google-chrome-for-testing`
- Binary: `/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`

CDP endpoint exposed on `localhost:9222`.

---

## Systemd units

### `/etc/systemd/system/xvfb.service`

```ini
[Unit]
Description=Xvfb Virtual Framebuffer on display :1
After=network.target

[Service]
Type=simple
ExecStartPre=/bin/bash -c "rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true"
ExecStart=/usr/bin/Xvfb :1 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

- `ExecStartPre` cleans stale X lock files so a crash-recovery restart doesn't fail with `Server is already active for display 1`.
- `Restart=always` — Xvfb dying triggers immediate respawn.

### `/etc/systemd/system/pm2-root.service`

```ini
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target xvfb.service
Requires=xvfb.service

[Service]
Type=forking
User=root
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
Environment=PM2_HOME=/root/.pm2
Environment=DISPLAY=:1
PIDFile=/root/.pm2/pm2.pid
Restart=on-failure
RestartSec=5

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
```

- `Requires=xvfb.service` + `After=xvfb.service` — PM2 cannot start until Xvfb is up, so any child that needs `DISPLAY=:1` (e.g. profile-api's Chrome) finds the display ready.
- `Environment=DISPLAY=:1` — all PM2-managed processes inherit this, no per-app env config needed.
- `ExecStart=pm2 resurrect` — reads `~/.pm2/dump.pm2` and brings back whatever was last `pm2 save`d. Update the dump with `pm2 save` after any process add/remove.

---

## Boot chain

```
boot
  └── network.target
        └── xvfb.service          (Xvfb on :1, screen 1920x1080x24)
              └── pm2-root.service (pm2 resurrect with DISPLAY=:1)
                    ├── pipeline-api
                    ├── stage-worker
                    ├── batch-worker
                    ├── profile-api
                    │     └── spawns Chrome on :1, CDP on :9222
                    └── meal-api
```

---

## Self-healing layers

| Layer | Mechanism | Recovery time |
|-------|-----------|---------------|
| Xvfb | systemd `Restart=always`, `RestartSec=3` | ~3s |
| PM2 daemon | systemd `Restart=on-failure`, `RestartSec=5` | ~5s (then `pm2 resurrect` restores apps) |
| Individual PM2 app | PM2 auto-restart on exit | seconds |
| Chrome (under profile-api) | profile-api health check — restarts after 2 consecutive 60s failures | up to ~2min |

The chain is designed so that any single component crashing triggers automatic recovery without manual intervention. Full reboot brings everything back via the systemd dependency.

---

## Resolved: pm2-root alignment (2026-06-02)

Previously `pm2-root.service` was enabled but inactive — PM2 had been started outside systemd, so the unit never tracked the daemon. Aligned by: `pm2 save` → `pm2 kill` → `systemctl start pm2-root.service`. After alignment the unit is **active**; PM2 daemon death now triggers systemd respawn.

The alignment surfaced two real issues, both fixed:

### Issue 1: PM2 6.0.14 cluster_mode broken on this server

`pipeline-api`, `stage-worker`, and `batch-worker` were running in `cluster_mode` (per the original `pm2 list`). After the realignment, the same apps in cluster_mode exited with code 9 + SIGINT within milliseconds of spawn — `pm2 logs` showed nothing because the crash preceded log file open. Running the same scripts directly via `node` (with identical `--env-file=.env --max-old-space-size=...` args) worked perfectly. The crash was specific to PM2 6.0.14's cluster mode interacting with this Node 20.20.0 build.

**Workaround applied:** started all 3 apps in `fork_mode` instead. Behaviorally equivalent at `instances: 1`. The `pm2 list` now shows `mode: fork` for all 4 apps.

**`ecosystem.config.cjs` not yet edited** — the file on disk still defaults to cluster (no explicit `exec_mode`). If the saved dump is ever lost and someone runs `pm2 start ecosystem.config.cjs`, they'll hit the same crash. The fix is to add `exec_mode: 'fork'` to each app block, or upgrade/downgrade PM2 once a working version is identified.

### Issue 2: dump.pm2 silently lost 3 of 5 processes

The original PM2 daemon was running 5 apps (pipeline-api, stage-worker, batch-worker, profile-api, meal-api) but `pm2 save` wrote a dump containing only 2 (pipeline-api, stage-worker). The dump's `.bak` from a prior save also contained only 2 — so the dump has been incomplete for a while, possibly since the apps were last manually started without `pm2 save` afterward.

**Recovery:** started missing apps explicitly via `pm2 start <script> --name <name>` and ran `pm2 save` again. Final dump contains all 5 apps. `meal-api` source was eventually located at `/var/www/meals-api/index.js` (non-standard path — the initial search over `/opt /root /home` missed `/var/www`). All apps now in fork mode, dump complete, both services active.

### Operational discipline

After any `pm2 start`/`pm2 delete`/manual process change: **always run `pm2 save` immediately**. Without that the dump goes stale and recovery from reboot loses everything since the last save. Past saves should not be trusted to contain the current process list.

---

## Cleaned up

The `websockify` proxy on port 6080 (left over from the TigerVNC era, proxying to a dead `:5901`) was killed 2026-06-02. It was a bare PPID-1 detached process with no systemd unit owning it, so a simple `kill` was sufficient — it does not respawn.

Note: `tigervncserver@.service` is still present in systemd but `disabled`. Harmless.

---

## Verification commands

Quick health check after any reboot or service change:

```bash
ssh hetzner '
  systemctl is-active xvfb.service
  systemctl is-active pm2-root.service
  curl -s -o /dev/null -w "CDP: HTTP %{http_code}\n" http://localhost:9222/json/version
  pm2 list
'
```

Expected output:
- `active` for xvfb
- `active` for pm2-root (currently inactive — see above)
- `HTTP 200` from CDP
- All 5 PM2 apps `online`

---

## History

- **2026-06-02 (later)** — Aligned PM2 daemon with `pm2-root.service` (was inactive despite daemon running). Switched pipeline-api / stage-worker / batch-worker from cluster_mode to fork_mode after cluster_mode under PM2 6.0.14 exited with code 9 + SIGINT instantly. Rebuilt dump.pm2 (was silently missing 3 of 5 apps). Removed manually-started `websockify` relic on port 6080. Discovered `meal-api` source missing from disk — not recovered.
- **2026-06-02** — Replaced manually-started TigerVNC on `:1` (running since 2026-04-25) with `xvfb.service`. Added `Requires=xvfb.service` + `Environment=DISPLAY=:1` to `pm2-root.service`. TigerVNC was fragile (no respawn, no boot-time start); Xvfb under systemd gives self-healing + clean boot chain.
- **Earlier** — `pm2-root.service` initially created by `pm2 startup` (standard PM2 systemd installer), edited today to add Xvfb dependency and DISPLAY env.
