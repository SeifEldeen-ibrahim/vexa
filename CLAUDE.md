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

The Chrome extension is NOT an image: `cd clients/nexus-extension && npm run package`
produces `dist/` (load unpacked) and a zip. Its README covers install and the sign-in flow.

nginx is the public front door and is NOT managed by compose. The tracked copy is
`deploy/nginx/nexus.biami.io.conf`; installing it needs root:

```sh
sudo cp deploy/nginx/nexus.biami.io.conf /etc/nginx/sites-enabled/nexus.biami.io.conf
sudo nginx -t && sudo systemctl reload nginx
```

End-to-end check for the in-person lane (reads `deploy/compose/.env`, prints no secrets):
`node deploy/compose/tests/live-smoke.mjs`.

Keep secrets out of Git and preserve other uncommitted work. Existing architecture,
ADRs, and governance documents are historical technical references, not a required
contribution or release process. Application workspace-seed CLAUDE.md files configure
the meeting agents; they are part of the product.
