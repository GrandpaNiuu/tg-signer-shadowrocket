# Project status

Repository bootstrap is complete.

## Installed

- GitHub Actions check-in workflow: `.github/workflows/daily-checkin.yml`
- Cloudflare Worker trigger code: `worker/cloudflare-worker.js`
- Cloudflare Worker deploy config: `worker/wrangler.toml`
- Cloudflare Worker deploy workflow: `.github/workflows/deploy-worker.yml`
- Shadowrocket module: `shadowrocket/tg-signer.sgmodule`
- Shadowrocket trigger script: `shadowrocket/trigger.js`
- Phone deployment guide: `docs/PHONE_DEPLOY.md`
- Session guide: `docs/SESSION_STRING.md`
- Codespaces devcontainer: `.devcontainer/devcontainer.json`

## Still requires manual secrets

You must add these values yourself. Do not commit them to files.

### GitHub Actions secrets

- `TG_SESSION_STRING`
- `TG_TARGET_CHAT`
- `TG_CHECKIN_TEXT`

Optional:

- `TELEGRAM_NOTIFY_BOT_TOKEN`
- `TELEGRAM_NOTIFY_CHAT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### Cloudflare Worker variables/secrets

- `TRIGGER_KEY`
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_WORKFLOW_FILE`
- `GITHUB_REF`

## Next action

1. Add GitHub Actions secrets.
2. Run `Actions -> Daily Telegram Checkin -> Run workflow` once.
3. Deploy Cloudflare Worker.
4. Import the Shadowrocket module.
