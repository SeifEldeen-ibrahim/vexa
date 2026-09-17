# Nexus development notes

This is BIAMI's Nexus application, based on Vexa. Work directly in the existing
checkout on `main`. Use ordinary `git add`, `git commit`, `git pull`, and `git push`.
No worktrees, required pull requests, contribution declarations, sign-off ceremony,
Git hooks, or CI/CD. Run relevant checks manually for the change being made.

`origin` is `https://github.com/SeifEldeen-ibrahim/vexa.git`.
The working deployment is https://nexus.biami.io, from `/home/biami/vexa`.

Layout: pnpm + turbo monorepo; `core/` contains backend services and agents,
`clients/terminal/` is the Next.js UI, and `deploy/compose/` runs the deployment.
Source changes go live only when the affected service image is rebuilt and restarted.

For terminal-only changes, from `deploy/compose/`:

```sh
docker compose -p vexa-v012 -f docker-compose.yml build terminal
docker compose -p vexa-v012 -f docker-compose.yml up -d --no-deps --no-build terminal
```

Keep secrets out of Git and preserve other uncommitted work. Existing architecture,
ADRs, and governance documents are historical technical references, not a required
contribution or release process. Application workspace-seed CLAUDE.md files configure
the meeting agents; they are part of the product.
