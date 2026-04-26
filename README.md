# NJ Job Auto Poster

A safe job-aggregation dashboard for your Facebook group **New Jersey Jobs**.

It collects NJ job leads, creates Facebook-ready posts, and lets you manually copy/schedule them. It does **not** log into Facebook or spam-post automatically, which helps keep your group safer.

## Features
- Pulls jobs from RSS feeds.
- Optional Adzuna API support.
- Optional USAJOBS API support.
- Auto-formats Facebook posts.
- Review dashboard: copy, edit, mark posted, skip.
- SQLite database stored in `/data` or your Railway volume.
- CSV export.
- Hourly job pulls by default.

## Local Setup
```bash
npm install
copy .env.example .env
npm start
```
Open: `http://localhost:3000`

The app can run with only RSS feeds, but the best results for warehouse, customer service, data entry, office/admin, retail, security, and entry-level jobs come from adding API keys:
- Adzuna: set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.
- USAJOBS: set `USAJOBS_USER_AGENT` and `USAJOBS_AUTH_KEY`.

## Railway Setup
1. Upload this folder to GitHub.
2. Create a Railway project from the repo.
3. Add a volume mounted to `/data`.
4. Set environment variables:
   - `DATA_DIR=/data`
   - Do not set `ADMIN_PASSWORD` if you want the dashboard open with no login.
   - Optional: `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`
   - Optional: `USAJOBS_USER_AGENT`, `USAJOBS_AUTH_KEY`
5. Deploy.

Railway will run `npm start`. Job records are saved to a SQLite database file at `$DATA_DIR/jobs.db`; with `DATA_DIR=/data`, that file stays on the Railway volume across deploys.

For your Railway setup, leave `ADMIN_PASSWORD` blank or delete the variable entirely so the dashboard does not require a password.

The app runs a background pull every hour by default:
```bash
FETCH_CRON=0 * * * *
```

Use cron syntax to change it. For example, every 30 minutes:
```bash
FETCH_CRON=*/30 * * * *
```

## Recommended Facebook Workflow
1. Click **Fetch New Jobs**.
2. Review jobs.
3. Edit post text if needed.
4. Click **Copy Facebook Post**.
5. Paste into your Facebook group or Meta Business Suite.
6. Mark as posted.

## Custom Job Keywords
Set this environment variable:
```bash
JOB_KEYWORDS=warehouse,data entry,customer service,office admin,clerical,receptionist,call center,driver,delivery,security,retail,no experience,entry level
```

For sources that return broad results, `PULL_TITLE_KEYWORDS` controls which jobs get saved:
```bash
PULL_TITLE_KEYWORDS=warehouse,data entry,customer service,office,admin,clerical,receptionist,call center,driver,delivery,retail,cashier,stock,shipping,receiving,forklift,packer,picker
```

## Add More RSS Feeds
Set:
```bash
EXTRA_RSS_FEEDS=https://example.com/jobs/rss,https://another-site.com/feed
```

## Important
Do not scrape websites aggressively or automate Facebook login/posting with a bot. Use APIs, RSS feeds, and manual review to avoid account restrictions.
