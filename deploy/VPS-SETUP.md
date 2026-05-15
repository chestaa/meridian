# Meridian VPS Setup

This project is meant to run on a VPS, not on the local laptop.

## Recommended server

- Ubuntu 22.04 or 24.04
- 2 vCPU
- 4 GB RAM
- 25 GB disk

## Bootstrap

Clone the repo on the VPS:

```bash
git clone https://github.com/yunus-0x/meridian.git /opt/meridian
cd /opt/meridian
```

Then run the bootstrap script:

```bash
bash scripts/bootstrap-vps.sh
```

## Secrets

Edit:

```bash
/opt/meridian/.env
```

Minimum required:

```env
OPENROUTER_API_KEY=
RPC_URL=
HELIUS_API_KEY=
DRY_RUN=true
```

For phase 1, keep this empty:

```env
WALLET_PRIVATE_KEY=
```

## Run in its own container

Build and run Meridian as an isolated Docker service:

```bash
cd /opt/meridian
docker compose up -d --build
```

## Useful commands

```bash
cd /opt/meridian && docker compose ps
cd /opt/meridian && docker compose logs -f meridian
cd /opt/meridian && docker compose restart meridian
cd /opt/meridian && docker compose down
cd /opt/meridian && npm test
cd /opt/meridian && node cli.js screen --dry-run --silent
```

## Phase policy

- Phase 1: `DRY_RUN=true`, no private key
- Phase 2: burner wallet only
- Phase 3: small live capital after review

## Discord Listener Activation (Phase 0+)

Path A signal source. Runs the Discord listener as a managed systemd service
that writes incoming signals to `signals/inbox/` for the signal-runner to
consume.

**Pre-requisite:** Vega's `discord-listener/index.js` patch must be landed
(the version that writes to `/opt/meridian/signals/inbox/`). Without it, the
service runs but no data reaches the screener.

1. Copy the unit file:

   ```bash
   sudo cp /opt/meridian/deploy/systemd/meridian-discord-listener.service /etc/systemd/system/
   ```

2. Reload systemd:

   ```bash
   sudo systemctl daemon-reload
   ```

3. Enable the service (start on boot):

   ```bash
   sudo systemctl enable meridian-discord-listener
   ```

4. Flip the flag in `/opt/meridian/user-config.json`:

   ```json
   "useDiscordSignals": true
   ```

5. Start the service:

   ```bash
   sudo systemctl start meridian-discord-listener
   ```

6. Verify (watch for inbox writes):

   ```bash
   journalctl -u meridian-discord-listener -f
   ```

**Rollback:**

```bash
sudo systemctl stop meridian-discord-listener
```

Then set `useDiscordSignals: false` in `user-config.json`.
