# Working on Nexus

Use the existing checkout and `main` branch:

```sh
git pull
# Make your changes and run the relevant checks.
git add <files>
git commit -m "Describe the change"
git push
```

No worktrees, mandatory PRs, contribution declarations, sign-offs, automated hooks,
or CI/CD are required. GitHub Actions is disabled for this repository. Builds,
tests, and deployments are run manually when needed.

The upstream governance documents are retained as historical reference only.
Keep credentials out of Git. Preserve the project's license and attribution.
