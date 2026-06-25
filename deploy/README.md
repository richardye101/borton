# Auto-deploy (poll + self-heal)

Keeps the LXC's `receipt-bot` in sync with `origin/main`: polls every 60s, and on a new
commit pulls, restarts, **waits for the bot to report it's up**, and **rolls back** to the
previous commit if it doesn't come up healthy within 30s.

## Install (run on the LXC, once)
```bash
cd /root/borton && git pull
sudo bash deploy/install.sh
```
That installs the deploy script to `/usr/local/bin/`, the systemd units, enables the timer,
and runs an initial deploy. From then on, every push to `main` lands within ~60s.

## Files
- `borton-deploy.sh` — fetch → compare → pull/npm/restart → health-check → rollback. Paths via
  `BORTON_DIR` (default `/root/borton`) and `BORTON_SERVICE` (default `receipt-bot`).
- `borton-deploy.service` / `.timer` — oneshot run on a 60s interval.

## How heavy is it?
A no-op tick is a single `git fetch origin main` with nothing to transfer — a few KB, a few ms,
no resident process. Real work only happens on an actual new commit.

## Health check
Success = the service is active **and** the journal shows `Long-polling` (printed once the bot
connects to Actual and starts polling Telegram). This catches crash-on-startup failures
(syntax errors, bad config, boot crashes) — not "boots fine but misbehaves"; revert those manually.

## Manual rollback
```bash
cd /root/borton
git reset --hard "$(cat .last-good)"   # last health-checked-good commit
# or any prior commit:
git log --oneline -10 && git reset --hard <sha>
systemctl restart receipt-bot
```
`git reflog` is the ultimate undo if you reset somewhere unintended.

## Watch / control
```bash
journalctl -u borton-deploy -f         # deploy activity
systemctl list-timers borton-deploy    # next/last run
systemctl disable --now borton-deploy.timer   # pause auto-deploy
```
