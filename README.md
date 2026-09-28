# UXArmy Contact Form Monitor

Playwright checks for https://uxarmy.com/contact-sales/ – field validation + real submit with API verification. Runs every 2 hours on GitHub Actions (free).

## Local
    npm install
    npx playwright install chromium
    npm test              # headless
    npm run test:headed   # watch it
    npm run discover      # Playwright codegen – pick exact selectors if labels change

## Deploy (GitHub Actions)
1. Push this folder to a GitHub repo.
2. Settings → Secrets and variables → Actions:
   - Secret `TEST_EMAIL` – e.g. qa+monitor@uxarmy.com
   - Secret `SLACK_WEBHOOK_URL` (optional) – failure alerts
   - Variable `SKIP_SUBMIT` = `true` to run validation only
3. Actions tab → "Contact form monitor" → Run workflow (first manual run).

Notes: GitHub cron can be delayed 5–15 min at busy times; scheduled workflows in
repos with no commits for 60 days get paused – push a commit or re-enable.
