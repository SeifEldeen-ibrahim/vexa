# Nexus development notes

This is BIAMI's Nexus application, based on Vexa. Work directly in the existing
checkout on `main`. Use ordinary `git add`, `git commit`, `git pull`, and `git push`.
No worktrees, required pull requests, contribution declarations, sign-off ceremony,
Git hooks, or CI/CD. Run relevant checks manually for the change being made.

`origin` is `https://github.com/SeifEldeen-ibrahim/vexa.git`.
The working deployment is https://nexus.biami.io, from `/home/biami/vexa`.

Layout: pnpm + turbo monorepo; `core/` contains backend services and agents,
`clients/terminal/` is the Next.js UI, `clients/nexus-extension/` is the Chrome extension
for in-person calls, and `deploy/compose/` runs the deployment.
Source changes go live only when the affected service image is rebuilt and restarted.

Rebuild + restart one service, from `deploy/compose/` (`terminal`, `meeting-api`, `live`, …):

```sh
docker compose -p vexa-v012 -f docker-compose.yml build terminal
docker compose -p vexa-v012 -f docker-compose.yml up -d --no-deps --no-build terminal
```

**Restarting `live` interrupts every in-person call in flight.** The session lives in that
container's memory. Since `e185d826` the call is HANDED OVER rather than dropped — the row stays
`active`, a note goes into redis (`nexus:live:handover`), and the extension's next reconnect
resumes it — so a restart now costs seconds of audio instead of the rest of the meeting. Still
check before restarting, because those seconds are somebody's meeting:

```sh
curl -s https://nexus.biami.io/live/health   # live_sessions should be 0
```

The Chrome extension is NOT an image: `cd clients/nexus-extension && npm run package`
produces `dist/` (load unpacked) and a zip. Its README covers install and the sign-in flow.

nginx is the public front door and is NOT managed by compose. The tracked copy is
`deploy/nginx/nexus.biami.io.conf`. The real file is `/etc/nginx/sites-available/nexus.biami.io.conf`
(`sites-enabled` is a symlink to it), so install over sites-available; this needs root:

```sh
sudo cp deploy/nginx/nexus.biami.io.conf /etc/nginx/sites-available/nexus.biami.io.conf
sudo nginx -t && sudo systemctl reload nginx
```

End-to-end check for the in-person lane (reads `deploy/compose/.env`, prints no secrets):
`node deploy/compose/tests/live-smoke.mjs`.

Keep secrets out of Git and preserve other uncommitted work. Existing architecture,
ADRs, and governance documents are historical technical references, not a required
contribution or release process. Application workspace-seed CLAUDE.md files configure
the meeting agents; they are part of the product.
