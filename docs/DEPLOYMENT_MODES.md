# Worker deployment modes

`Deploy Cloudflare Worker` supports three explicit modes. Migrations always run before any inventory audit or Worker deployment.

## `bootstrap`

Use only when the Worker service does not exist yet.

1. Create the D1 database and configure `worker/wrangler.toml`.
2. Configure the GitHub deployment secrets and `WORKER_URL` repository variable.
3. Run the workflow with `deployment_mode=bootstrap`.
4. The workflow applies migrations, deploys the Worker, and requires `/health` to return `{ "ok": true }`.
5. Configure the remaining Worker secrets in Cloudflare, including `GITHUB_TOKEN`, `SECRET_ROOT_KEY`, and OAuth credentials.
6. Rerun the workflow with `deployment_mode=fresh_install`; `/ready` must then pass.

`bootstrap` intentionally does not accept an unhealthy `/health` response. It only skips `/ready` because the remaining Worker secrets may not exist before the service is created.

## `fresh_install`

This is the default mode for normal upgrades, an empty D1 database after the initial service bootstrap, and pushes to `main` that touch Worker files.

The workflow:

1. runs Runner, Worker, and deployment-safety tests;
2. applies D1 migrations;
3. deploys the Worker;
4. verifies both `/health` and `/ready` over HTTPS.

A missing `WORKER_URL`, invalid deployment secret, failed migration, non-200 endpoint, invalid JSON body, or `{ "ok": false }` fails the workflow.

## `legacy_takeover`

Use only before retiring an older scheduling or secret source.

After migrations, the workflow requires count-only evidence for:

- at least one migrated Telegram account;
- at least one connected account;
- an encrypted Telegram Session for every connected account;
- at least one migrated task;
- at least one successful D1 Runner canary.

The audit output contains only aggregate counts. It does not print phone numbers, Sessions, task commands, Tokens, API hashes, or other user data. Deployment then continues and must pass both `/health` and `/ready`.

Once the legacy path is retired, return to `fresh_install` for future deployments.

## Rollback

These deployment mode changes do not alter historical migrations. If a new Worker version fails its smoke check, inspect the deployment run, restore the previous Worker version in Cloudflare, and keep the D1 data in place unless a separately reviewed migration explicitly requires a data rollback.
