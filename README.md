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
- Jooble: set `JOOBLE_API_KEY`.
- USAJOBS: set `USAJOBS_USER_AGENT` and `USAJOBS_AUTH_KEY`.

## Railway Setup
1. Upload this folder to GitHub.
2. Create a Railway project from the repo.
3. Add a volume mounted to `/data`.
4. Set environment variables:
   - `DATA_DIR=/data`
   - Do not set `ADMIN_PASSWORD` if you want the dashboard open with no login.
   - Optional: `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`
   - Optional: `JOOBLE_API_KEY`
   - Optional: `USAJOBS_USER_AGENT`, `USAJOBS_AUTH_KEY`
5. Deploy.

Railway will run `npm start`. Job records are saved to a SQLite database file at `$DATA_DIR/jobs.db`; with `DATA_DIR=/data`, that file stays on the Railway volume across deploys.

The dashboard defaults to showing **all** saved jobs from SQLite. Use **View Saved Jobs** to review what is already stored without pulling anything new. **Fetch New Jobs** only inserts new, non-duplicate jobs and does not clear old jobs.
Each job shows an age label based on the source's posted date when available, or the saved date when the source does not provide a posted date.

For your Railway setup, leave `ADMIN_PASSWORD` blank or delete the variable entirely so the dashboard does not require a password.

The app runs a background pull every hour by default:
```bash
FETCH_CRON=0 * * * *
FETCH_PROFILE_IDS=nj,mississauga
```

The built-in location menu includes:
```text
NJ Job Auto Poster -> New Jersey
Mississauga Job Auto Poster -> Mississauga, Ontario, Canada
```

Advanced: override the menu with `LOCATION_PROFILES_JSON` if you want more cities later.

Use cron syntax to change it. For example, every 30 minutes:
```bash
FETCH_CRON=*/30 * * * *
```

Newspaper and local classified pages run separately twice per day by default:
```bash
NEWSPAPER_FETCH_CRON=0 8,20 * * *
NEWSPAPER_PAGE_URLS=https://patch.com/new-jersey/across-nj/localjobs,https://jobs.nj.com/careers/jobsearch
NEWSPAPER_RSS_FEEDS=
```

Prefer RSS feeds when a newspaper offers them. Keep page scraping to a short list of public job/classified pages and review the saved leads before posting.

## Recommended Facebook Workflow
1. Click **Fetch New Jobs**.
2. Review jobs.
3. Edit post text if needed.
4. Click **Copy Link Preview** for a Facebook card-style post, or **Copy Full Post** for detailed text.
5. Paste into your Facebook group composer.
6. Mark as posted.

Meta removed third-party publishing support for Facebook Groups, so this app does not auto-post into groups. It prepares the post, copies it, and opens your group:
```bash
FACEBOOK_GROUP_URL=https://www.facebook.com/groups/jobsinnewjersey
```

## Facebook Page Auto-Posting
Facebook Groups cannot be auto-posted through Meta's official API anymore, but Facebook Pages can. Create or use a Facebook Page for the automated job feed, then add these Railway variables:
```bash
FACEBOOK_PAGE_ID=your-page-id
FACEBOOK_PAGE_ACCESS_TOKEN=your-page-access-token
FACEBOOK_GRAPH_VERSION=v24.0
FACEBOOK_AUTO_POST_CRON=15 * * * *
FACEBOOK_AUTO_POST_LIMIT=3
```

With those set, the app posts up to `FACEBOOK_AUTO_POST_LIMIT` unposted jobs to the Page on the schedule. Jobs already posted to the Page are tracked with `facebook_posted_at` and will not be posted again.

## Custom Job Keywords
Set this environment variable:
```bash
JOB_KEYWORDS=warehouse,data entry,customer service,office admin,clerical,receptionist,call center,driver,delivery,security,retail,no experience,entry level
```

For sources that return broad results, `PULL_TITLE_KEYWORDS` controls which jobs get saved:
```bash
PULL_TITLE_KEYWORDS=warehouse,data entry,customer service,office,admin,clerical,receptionist,call center,driver,delivery,retail,cashier,stock,shipping,receiving,forklift,packer,picker
```

Facebook post hashtags can be customized with:
```bash
POST_HASHTAGS=#NewJerseyJobs #NJJobs #NowHiring #JobsInNewJersey #HiringNJ
```
The app also adds location and work-type hashtags such as `#EdisonJobs`, `#EdisonNJ`, `#WarehouseJobs`, `#DataEntryJobs`, `#CustomerServiceJobs`, `#PartTimeJobs`, and `#RemoteJobs` when they match the job.

## Add More RSS Feeds
Set:
```bash
EXTRA_RSS_FEEDS=https://example.com/jobs/rss,https://another-site.com/feed
```

The built-in RSS feeds are NJLM municipal jobs/classifieds feeds. They may legitimately return zero jobs when NJLM has no current RSS items. The dashboard source panel shows configured keys and saved job counts by source.

## Important
Do not scrape websites aggressively or automate Facebook login/posting with a bot. Use APIs, RSS feeds, and manual review to avoid account restrictions.
