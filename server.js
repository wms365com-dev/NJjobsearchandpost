require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const Parser = require('rss-parser');
const initSqlJs = require('sql.js');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FACEBOOK_GROUP_URL = process.env.FACEBOOK_GROUP_URL || 'https://www.facebook.com/groups/jobsinnewjersey';
const FACEBOOK_GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v24.0';
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '';
const FACEBOOK_PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultLocationProfiles = [
  { id: 'nj', label: 'NJ Job Auto Poster', location: 'New Jersey', regionLabel: 'NEW JERSEY', country: 'us' },
  { id: 'mississauga', label: 'Mississauga Job Auto Poster', location: 'Mississauga, Ontario, Canada', regionLabel: 'MISSISSAUGA, ONTARIO', country: 'ca' }
];
function getLocationProfiles() {
  try {
    const parsed = JSON.parse(process.env.LOCATION_PROFILES_JSON || '');
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return defaultLocationProfiles;
}
const locationProfiles = getLocationProfiles();
function getLocationProfile(idOrLocation) {
  return locationProfiles.find(p => p.id === idOrLocation || p.location === idOrLocation) || locationProfiles[0];
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(DATA_DIR, 'jobs.db');
let dbPromise;
let db;

async function getDb() {
  if (db) return db;
  if (!dbPromise) {
    dbPromise = initSqlJs().then(SQL => {
      const database = fs.existsSync(DB_FILE)
        ? new SQL.Database(fs.readFileSync(DB_FILE))
        : new SQL.Database();
      database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT,
        external_id TEXT UNIQUE,
        title TEXT,
        company TEXT,
        location TEXT,
        salary TEXT,
        description TEXT,
        url TEXT,
        category TEXT,
        date_posted TEXT,
        status TEXT DEFAULT 'new',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        post_text TEXT,
        search_location TEXT,
        facebook_post_id TEXT,
        facebook_posted_at TEXT,
        facebook_post_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
      `);
      ensureColumn(database, 'jobs', 'facebook_post_id', 'TEXT');
      ensureColumn(database, 'jobs', 'facebook_posted_at', 'TEXT');
      ensureColumn(database, 'jobs', 'facebook_post_error', 'TEXT');
      ensureColumn(database, 'jobs', 'search_location', 'TEXT');
      database.exec(`UPDATE jobs SET search_location='New Jersey' WHERE search_location IS NULL OR search_location=''`);
      db = database;
      persistDb();
      return db;
    });
  }
  return dbPromise;
}

function persistDb() {
  if (!db) return;
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function queryAll(database, sql, params = []) {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function runSql(database, sql, params = []) {
  const stmt = database.prepare(sql);
  stmt.run(params);
  stmt.free();
}
function ensureColumn(database, table, column, type) {
  const columns = queryAll(database, `PRAGMA table_info(${table})`);
  if (columns.some(item => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const rssParser = new Parser({ timeout: 12000 });
const keywords = (process.env.JOB_KEYWORDS || 'warehouse,data entry,customer service,office admin,clerical,receptionist,call center,driver,delivery,security,retail,no experience,entry level')
  .split(',').map(s => s.trim()).filter(Boolean);
const fetchCron = process.env.FETCH_CRON || '0 * * * *';
const newspaperFetchCron = process.env.NEWSPAPER_FETCH_CRON || '0 8,20 * * *';
const facebookAutoPostCron = process.env.FACEBOOK_AUTO_POST_CRON || '15 * * * *';
const facebookAutoPostLimit = Number(process.env.FACEBOOK_AUTO_POST_LIMIT || 3);
const fetchProfileIds = (process.env.FETCH_PROFILE_IDS || 'nj,mississauga').split(',').map(s => s.trim()).filter(Boolean);
const newspaperFeeds = (process.env.NEWSPAPER_RSS_FEEDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const newspaperPages = (process.env.NEWSPAPER_PAGE_URLS || 'https://patch.com/new-jersey/across-nj/localjobs,https://jobs.nj.com/careers/jobsearch')
  .split(',').map(s => s.trim()).filter(Boolean);
const defaultRssFeeds = [
  'https://www.njlm.org/RSSFeed.aspx?CID=All-0&CommunityJobs=False&ModID=66',
  'https://www.njlm.org/RSSFeed.aspx?CID=Classifieds-100&CommunityJobs=False&ModID=66'
];
const extraRssFeeds = (process.env.EXTRA_RSS_FEEDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const pullTitleKeywords = (process.env.PULL_TITLE_KEYWORDS || 'warehouse,data entry,customer service,office,admin,clerical,receptionist,call center,driver,delivery,retail,cashier,stock,shipping,receiving,forklift,packer,picker')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const excludedTitlePattern = /\b(senior|principal|engineer|developer|software|cloud|devops|architect|scientist)\b/i;
const defaultHashtags = (process.env.POST_HASHTAGS || '#NewJerseyJobs #NJJobs #NowHiring #JobsInNewJersey #HiringNJ')
  .split(/\s+/).map(s => s.trim()).filter(Boolean);

function clean(s='') { return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function detectCategory(title='', desc='') {
  const t = `${title} ${desc}`.toLowerCase();
  if (/warehouse|picker|packer|forklift|fulfillment|shipping|receiving/.test(t)) return 'Warehouse';
  if (/driver|cdl|delivery|truck|courier/.test(t)) return 'Driver / Delivery';
  if (/data entry|typist|order entry|billing|records/.test(t)) return 'Data Entry';
  if (/customer service|call center|csr|client service|support representative/.test(t)) return 'Customer Service';
  if (/office|admin|clerk|reception|front desk|scheduler/.test(t)) return 'Office / Admin';
  if (/construction|laborer|electrician|plumber|hvac/.test(t)) return 'Skilled Trades';
  if (/security|guard/.test(t)) return 'Security';
  if (/nurse|caregiver|medical|healthcare|dental/.test(t)) return 'Healthcare';
  if (/retail|cashier|store|sales associate/.test(t)) return 'Retail';
  return 'General';
}
function buildPost(job) {
  const salary = job.salary ? `\nPay: ${job.salary}` : '';
  const footer = process.env.POST_FOOTER || 'Follow New Jersey Jobs for daily hiring updates.';
  const hashtags = buildHashtags(job);
  const profile = getLocationProfile(job.search_location || job.location);
  return `NOW HIRING - ${profile.regionLabel || profile.location.toUpperCase()}\n\nJob: ${job.title || 'Job Opening'}\nCompany: ${job.company || 'Company not listed'}\nLocation: ${job.location || profile.location}${salary}\n\nCategory: ${job.category || 'General'}\nApply / details: ${job.url}\n\n${footer}\n\n${hashtags}`;
}
function buildLinkPreviewPost(job) {
  const salary = job.salary ? `\n${job.salary}` : '';
  const hashtags = buildHashtags(job);
  return `${job.url || ''}\n\n${job.title || 'Job Opening'}\n${job.company || 'Company not listed'}\n${job.location || 'New Jersey'}${salary}\n\n${hashtags}`.trim();
}
function buildHashtags(job) {
  const category = String(job.category || '').toLowerCase();
  const title = String(job.title || '').toLowerCase();
  const location = String(job.location || '').toLowerCase();
  const locationText = `${job.location || ''} ${job.search_location || ''}`.toLowerCase();
  const baseTags = /mississauga|ontario|canada|\bon\b/.test(locationText)
    ? defaultHashtags.filter(tag => !/newjersey|njjobs|jobsinnewjersey|hiringnj/i.test(tag))
    : defaultHashtags;
  const tags = [...baseTags, ...buildLocationHashtags(job.location || job.search_location)];
  if (/warehouse|picker|packer|forklift|shipping|receiving/.test(`${category} ${title}`)) tags.push('#WarehouseJobs', '#WarehouseHiring');
  if (/data entry|clerical|office|admin|reception/.test(`${category} ${title}`)) tags.push('#DataEntryJobs', '#OfficeJobs');
  if (/customer service|call center|csr/.test(`${category} ${title}`)) tags.push('#CustomerServiceJobs');
  if (/driver|delivery|cdl/.test(`${category} ${title}`)) tags.push('#DriverJobs', '#DeliveryJobs');
  if (/retail|cashier|stock/.test(`${category} ${title}`)) tags.push('#RetailJobs');
  if (/security|guard/.test(`${category} ${title}`)) tags.push('#SecurityJobs');
  if (/part.time|part time/.test(`${title} ${category}`)) tags.push('#PartTimeJobs');
  if (/full.time|full time/.test(`${title} ${category}`)) tags.push('#FullTimeJobs');
  if (/remote|work from home/.test(`${title} ${location}`)) tags.push('#RemoteJobs', '#WorkFromHome');
  if (/new jersey|\bnj\b/.test(location)) tags.push('#NewJersey');
  if (/mississauga/.test(location)) tags.push('#MississaugaJobs', '#MississaugaHiring');
  if (/ontario|\bon\b/.test(location)) tags.push('#OntarioJobs');
  if (/canada/.test(location)) tags.push('#CanadaJobs');
  return [...new Set(tags)].join(' ');
}
function buildLocationHashtags(location='') {
  const full = String(location || '');
  const raw = full.split(',')[0].trim();
  if (!raw || /^new jersey$/i.test(raw)) return ['#NJ'];
  const city = raw.replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, '');
  if (!city) return ['#NJ'];
  if (/ontario|canada|\bon\b/i.test(full)) return [`#${city}Jobs`, `#${city}ON`];
  return [`#${city}Jobs`, `#${city}NJ`];
}
function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function getJobAge(job) {
  const date = parseDate(job.date_posted) || parseDate(job.created_at);
  if (!date) return { label: 'Age unknown', days: null, source: '' };
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  const source = job.date_posted ? 'posted' : 'saved';
  if (days === 0) return { label: `Today (${source})`, days, source };
  if (days === 1) return { label: `1 day old (${source})`, days, source };
  return { label: `${days} days old (${source})`, days, source };
}
function decorateJob(job) {
  const age = getJobAge(job);
  return { ...job, age_label: age.label, age_days: age.days, age_source: age.source };
}
function shouldPullJob(title='', desc='') {
  const normalizedTitle = String(title || '').toLowerCase();
  const normalizedDesc = String(desc || '').toLowerCase();
  if (excludedTitlePattern.test(normalizedTitle)) return false;
  return pullTitleKeywords.some(keyword => normalizedTitle.includes(keyword) || normalizedDesc.includes(keyword));
}
function toAbsoluteUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return '';
  }
}
async function upsertJob(job) {
  const database = await getDb();
  const external_id = job.external_id || `${job.source}:${job.url}`;
  const existing = queryAll(database, 'SELECT id FROM jobs WHERE external_id=?', [external_id])[0];
  const record = { ...job, external_id, search_location: job.search_location || getLocationProfile().location, category: job.category || detectCategory(job.title, job.description) };
  record.post_text = buildPost(record);
  if (existing) return false;
  runSql(database, `INSERT INTO jobs (source,external_id,title,company,location,salary,description,url,category,date_posted,post_text,search_location)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      record.source,
      record.external_id,
      record.title,
      record.company,
      record.location,
      record.salary,
      record.description,
      record.url,
      record.category,
      record.date_posted,
      record.post_text,
      record.search_location
    ]);
  persistDb();
  return true;
}

async function fetchAdzuna(profile = getLocationProfile()) {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return { source: 'adzuna', added: 0, skipped: 'missing keys' };
  let added = 0;
  for (const kw of keywords.slice(0, 10)) {
    const country = profile.country || 'us';
    const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}&where=${encodeURIComponent(profile.location)}&what=${encodeURIComponent(kw)}&results_per_page=20&sort_by=date`;
    const res = await fetch(url); if (!res.ok) continue;
    const data = await res.json();
    for (const j of (data.results || [])) {
      if (await upsertJob({ source:'Adzuna', external_id:`adzuna:${profile.id}:${j.id}`, search_location: profile.location, title:j.title, company:j.company?.display_name || '', location:j.location?.display_name || profile.location, salary: j.salary_min ? `$${Math.round(j.salary_min).toLocaleString()}+` : '', description: clean(j.description || '').slice(0,500), url:j.redirect_url, date_posted:j.created })) added++;
    }
  }
  return { source: 'adzuna', added };
}

async function fetchUSAJobs(profile = getLocationProfile()) {
  if ((profile.country || 'us') !== 'us') return { source: 'usajobs', added: 0, skipped: 'US only source' };
  const auth = process.env.USAJOBS_AUTH_KEY, ua = process.env.USAJOBS_USER_AGENT;
  if (!auth || !ua) return { source: 'usajobs', added: 0, skipped: 'missing keys' };
  const url = `https://data.usajobs.gov/api/Search?LocationName=${encodeURIComponent(profile.location)}&ResultsPerPage=50&DatePosted=30&SortField=OpenDate&SortDirection=Desc`;
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Authorization-Key': auth, 'Host': 'data.usajobs.gov' } });
  if (!res.ok) return { source: 'usajobs', added: 0, error: res.statusText };
  const data = await res.json(); let added = 0;
  for (const item of data.SearchResult?.SearchResultItems || []) {
    const d = item.MatchedObjectDescriptor || {};
    if (await upsertJob({ source:'USAJOBS', external_id:`usajobs:${profile.id}:${d.PositionID}`, search_location: profile.location, title:d.PositionTitle, company:d.OrganizationName, location:(d.PositionLocation || []).map(x=>x.LocationName).join(', ') || profile.location, salary:d.PositionRemuneration?.[0]?.MinimumRange ? `$${d.PositionRemuneration[0].MinimumRange} - $${d.PositionRemuneration[0].MaximumRange}` : '', description: clean(d.QualificationSummary || '').slice(0,500), url:d.PositionURI, date_posted:d.PublicationStartDate })) added++;
  }
  return { source: 'usajobs', added };
}

async function fetchJooble(profile = getLocationProfile()) {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) return { source: 'jooble', added: 0, skipped: 'missing key' };

  let added = 0;
  let checked = 0;
  const searchTerms = keywords.slice(0, 12);

  for (const keyword of searchTerms) {
    const res = await fetch(`https://jooble.org/api/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: keyword,
        location: profile.location,
        page: 1,
        ResultOnPage: 20
      })
    });

    if (!res.ok) return { source: 'jooble', added, checked, error: res.statusText };
    const data = await res.json();

    for (const j of (data.jobs || [])) {
      checked++;
      const title = j.title || 'Job Opening';
      const description = clean(j.snippet || j.description || '').slice(0, 500);
      if (!shouldPullJob(title, description)) continue;

      if (await upsertJob({
        source: 'Jooble',
        external_id: `jooble:${profile.id}:${j.id || j.link}`,
        search_location: profile.location,
        title,
        company: j.company || '',
        location: j.location || profile.location,
        salary: j.salary || '',
        description,
        url: j.link || '',
        date_posted: j.updated || ''
      })) added++;
    }
  }

  return { source: 'jooble', added, checked };
}

async function fetchTheMuse(profile = getLocationProfile()) {
  let added = 0;
  let checked = 0;

  for (let page = 1; page <= 3; page++) {
    const url = `https://www.themuse.com/api/public/jobs?page=${page}&location=${encodeURIComponent(profile.location)}`;
    const res = await fetch(url);
    if (!res.ok) return { source: 'themuse', added, checked, error: res.statusText };

    const data = await res.json();
    const jobs = data.results || [];
    checked += jobs.length;

    for (const j of jobs) {
      const description = clean(j.contents || '').slice(0, 500);
      if (!shouldPullJob(j.name, description)) continue;

      const locations = (j.locations || []).map(location => location.name).join(', ') || profile.location;
      const company = j.company?.name || '';
      const url = j.refs?.landing_page || j.refs?.landingPage || '';

      if (await upsertJob({
        source: 'The Muse',
        external_id: `themuse:${profile.id}:${j.id}`,
        search_location: profile.location,
        title: j.name || 'Job Opening',
        company,
        location: locations,
        salary: '',
        description,
        url,
        date_posted: j.publication_date || ''
      })) added++;
    }
  }

  return { source: 'themuse', added, checked };
}

async function fetchRSS(profile = getLocationProfile()) {
  if (profile.id !== 'nj') return { source: 'rss', added: 0, skipped: 'NJ RSS feeds only' };
  const feeds = [...defaultRssFeeds, ...extraRssFeeds];
  let added = 0, results = [];
  for (const feed of feeds) {
    try {
      const parsed = await rssParser.parseURL(feed);
      for (const item of parsed.items || []) {
        const text = clean(item.contentSnippet || item.content || item.summary || '');
        const loc = /\b(NJ|New Jersey)\b/i.test(`${item.title} ${text}`) ? 'New Jersey' : '';
        if (await upsertJob({ source:'RSS', external_id:`rss:${profile.id}:${item.guid || item.link || item.title}`, search_location: profile.location, title:clean(item.title), company:parsed.title || 'Job Board', location:loc || profile.location, salary:'', description:text.slice(0,500), url:item.link, date_posted:item.isoDate || item.pubDate || '' })) added++;
      }
      results.push({ feed, ok:true });
    } catch (e) { results.push({ feed, ok:false, error:e.message }); }
  }
  return { source: 'rss', added, results };
}

async function fetchNewspaperRSS() {
  let added = 0, results = [];
  for (const feed of newspaperFeeds) {
    try {
      const parsed = await rssParser.parseURL(feed);
      for (const item of parsed.items || []) {
        const title = clean(item.title);
        const description = clean(item.contentSnippet || item.content || item.summary || '').slice(0, 500);
        if (!shouldPullJob(title, description)) continue;
        if (await upsertJob({
          source: 'Newspaper RSS',
          external_id: `newspaper-rss:${item.guid || item.link || title}`,
          title,
          company: parsed.title || 'Newspaper / Local Source',
          location: /\b(NJ|New Jersey)\b/i.test(`${title} ${description}`) ? 'New Jersey' : 'New Jersey',
          salary: '',
          description,
          url: item.link,
          date_posted: item.isoDate || item.pubDate || ''
        })) added++;
      }
      results.push({ feed, ok:true });
    } catch (e) { results.push({ feed, ok:false, error:e.message }); }
  }
  return { source: 'newspaper-rss', added, results };
}

async function fetchNewspaperPages() {
  let added = 0, checked = 0, results = [];
  for (const pageUrl of newspaperPages.slice(0, 10)) {
    try {
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'NJJobAutoPoster/1.0 (+manual Facebook group job lead review)'
        }
      });
      if (!res.ok) {
        results.push({ pageUrl, ok:false, error: res.statusText });
        continue;
      }
      const $ = cheerio.load(await res.text());
      const seen = new Set();
      const links = [];
      const pageTitle = clean($('title').first().text()) || 'Newspaper / Local Source';

      $('a[href]').each((_, el) => {
        if (seen.size >= 60) return;
        const title = clean($(el).text());
        const href = toAbsoluteUrl($(el).attr('href'), pageUrl);
        if (!title || !href || seen.has(href)) return;
        seen.add(href);
        links.push({ title, href });
      });

      for (const { title, href } of links) {
        checked++;
        if (!shouldPullJob(title, pageTitle)) continue;
        if (await upsertJob({
          source: 'Newspaper Page',
          external_id: `newspaper-page:${href}`,
          title,
          company: pageTitle,
          location: 'New Jersey',
          salary: '',
          description: `Found on ${pageUrl}`,
          url: href,
          date_posted: ''
        })) added++;
      }
      results.push({ pageUrl, ok:true, checked: seen.size });
    } catch (e) { results.push({ pageUrl, ok:false, error:e.message }); }
  }
  return { source: 'newspaper-pages', added, checked, results };
}

async function runNewspaperFetch() {
  const results = [];
  results.push(await fetchNewspaperRSS());
  results.push(await fetchNewspaperPages());
  return results;
}

async function runFetch(profileId) {
  const profile = getLocationProfile(profileId);
  const results = [];
  results.push(await fetchJooble(profile));
  results.push(await fetchTheMuse(profile));
  results.push(await fetchRSS(profile));
  results.push(await fetchAdzuna(profile));
  results.push(await fetchUSAJobs(profile));
  return results;
}
async function runScheduledFetch() {
  const results = [];
  for (const profileId of fetchProfileIds) {
    results.push({ profile: getLocationProfile(profileId), results: await runFetch(profileId) });
  }
  return results;
}

function facebookPageConfigured() {
  return Boolean(FACEBOOK_PAGE_ID && FACEBOOK_PAGE_ACCESS_TOKEN);
}

async function postJobToFacebookPage(job) {
  if (!facebookPageConfigured()) {
    return { ok: false, error: 'missing FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN' };
  }

  const body = new URLSearchParams({
    access_token: FACEBOOK_PAGE_ACCESS_TOKEN,
    message: job.post_text || buildPost(job)
  });
  if (job.url) body.set('link', job.url);

  const res = await fetch(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}/feed`, {
    method: 'POST',
    body
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.error?.message || res.statusText, data };
  return { ok: true, id: data.id, data };
}

async function markFacebookPostResult(jobId, result) {
  const database = await getDb();
  if (result.ok) {
    runSql(database, 'UPDATE jobs SET facebook_post_id=?, facebook_posted_at=?, facebook_post_error=NULL WHERE id=?', [
      result.id || '',
      new Date().toISOString(),
      jobId
    ]);
  } else {
    runSql(database, 'UPDATE jobs SET facebook_post_error=? WHERE id=?', [
      result.error || 'Unknown Facebook post error',
      jobId
    ]);
  }
  persistDb();
}

async function postJobByIdToFacebookPage(id) {
  const database = await getDb();
  const job = queryAll(database, 'SELECT * FROM jobs WHERE id=? LIMIT 1', [id])[0];
  if (!job) return { ok: false, error: 'job not found' };
  const result = await postJobToFacebookPage(job);
  await markFacebookPostResult(job.id, result);
  return { jobId: job.id, title: job.title, ...result };
}

async function runFacebookAutoPost(limit = facebookAutoPostLimit) {
  if (!facebookPageConfigured()) {
    return { source: 'facebook-page', posted: 0, skipped: 'missing page id or token' };
  }
  const database = await getDb();
  const jobs = queryAll(database, `SELECT * FROM jobs
    WHERE status='new' AND facebook_posted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ?`, [Math.max(1, Number(limit) || 1)]);
  const results = [];
  for (const job of jobs) {
    results.push(await postJobByIdToFacebookPage(job.id));
  }
  return { source: 'facebook-page', posted: results.filter(item => item.ok).length, checked: jobs.length, results };
}

function requireAdmin(req,res,next){
  const configuredPassword = (process.env.ADMIN_PASSWORD || '').trim();
  const pass = req.headers['x-admin-password'] || req.query.password;
  if (!configuredPassword || pass === configuredPassword) return next();
  res.status(401).json({ error:'Admin password required' });
}

app.post('/api/fetch', requireAdmin, async (req,res)=> res.json({ profile: getLocationProfile(req.body?.profile || req.query.profile), results: await runFetch(req.body?.profile || req.query.profile) }));
app.post('/api/fetch-newspapers', requireAdmin, async (req,res)=> res.json({ results: await runNewspaperFetch() }));
app.get('/api/config', requireAdmin, (req,res)=> res.json({
  facebookGroupUrl: FACEBOOK_GROUP_URL,
  facebookPageConfigured: facebookPageConfigured(),
  facebookAutoPostLimit,
  facebookAutoPostCron,
  locationProfiles,
  fetchProfileIds,
  joobleConfigured: Boolean(process.env.JOOBLE_API_KEY),
  adzunaConfigured: Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
  usajobsConfigured: Boolean(process.env.USAJOBS_USER_AGENT && process.env.USAJOBS_AUTH_KEY),
  defaultRssFeeds,
  extraRssFeeds,
  newspaperFeeds,
  newspaperPages
}));
app.get('/api/jobs', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const status = req.query.status || 'all';
  const profile = getLocationProfile(req.query.profile);
  const locationClause = "COALESCE(search_location, 'New Jersey') = ?";
  const rows = status === 'all'
    ? queryAll(database, `SELECT * FROM jobs WHERE ${locationClause} ORDER BY created_at DESC LIMIT 300`, [profile.location])
    : queryAll(database, `SELECT * FROM jobs WHERE status=? AND ${locationClause} ORDER BY created_at DESC LIMIT 300`, [status, profile.location]);
  res.json(rows.map(decorateJob));
});
app.get('/api/source-counts', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const profile = getLocationProfile(req.query.profile);
  res.json(queryAll(database, `SELECT source, COUNT(*) AS count
    FROM jobs
    WHERE COALESCE(search_location, 'New Jersey') = ?
    GROUP BY source
    ORDER BY count DESC`, [profile.location]));
});
app.post('/api/jobs/:id/status', requireAdmin, async (req,res)=>{
  const database = await getDb();
  runSql(database, 'UPDATE jobs SET status=? WHERE id=?', [req.body.status || 'posted', req.params.id]);
  persistDb();
  res.json({ ok:true });
});
app.post('/api/jobs/:id/post', requireAdmin, async (req,res)=>{
  const database = await getDb();
  runSql(database, 'UPDATE jobs SET post_text=? WHERE id=?', [req.body.post_text || '', req.params.id]);
  persistDb();
  res.json({ ok:true });
});
app.post('/api/jobs/:id/refresh-post', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const job = queryAll(database, 'SELECT * FROM jobs WHERE id=? LIMIT 1', [req.params.id])[0];
  if (!job) return res.status(404).json({ error: 'job not found' });
  const postText = buildPost(job);
  runSql(database, 'UPDATE jobs SET post_text=? WHERE id=?', [postText, req.params.id]);
  persistDb();
  res.json({ ok:true, post_text: postText });
});
app.get('/api/jobs/:id/link-preview-post', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const job = queryAll(database, 'SELECT * FROM jobs WHERE id=? LIMIT 1', [req.params.id])[0];
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({ post_text: buildLinkPreviewPost(job) });
});
app.post('/api/jobs/:id/facebook-page', requireAdmin, async (req,res)=> res.json(await postJobByIdToFacebookPage(req.params.id)));
app.post('/api/facebook-page/auto-post', requireAdmin, async (req,res)=> res.json(await runFacebookAutoPost(req.body?.limit || facebookAutoPostLimit)));
app.get('/api/export.csv', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const rows = queryAll(database, 'SELECT title,company,location,salary,category,url,status,created_at,post_text FROM jobs ORDER BY created_at DESC');
  const csv = ['Title,Company,Location,Salary,Category,URL,Status,Created,Post Text', ...rows.map(r => Object.values(r).map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv'); res.send(csv);
});
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

if (require.main === module) {
  getDb().then(() => {
    cron.schedule(fetchCron, () => runScheduledFetch().catch(console.error));
    cron.schedule(newspaperFetchCron, () => runNewspaperFetch().catch(console.error));
    if (facebookPageConfigured()) cron.schedule(facebookAutoPostCron, () => runFacebookAutoPost().catch(console.error));
    app.listen(PORT, ()=> console.log(`NJ Job Auto Poster running on ${PORT}; fetch schedule: ${fetchCron}; newspaper schedule: ${newspaperFetchCron}; facebook page schedule: ${facebookPageConfigured() ? facebookAutoPostCron : 'disabled'}`));
  }).catch(err => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
}

module.exports = { app, runFetch, runScheduledFetch, runNewspaperFetch, runFacebookAutoPost, postJobByIdToFacebookPage, buildPost, buildLinkPreviewPost, detectCategory, getDb, fetchJooble, fetchTheMuse, fetchNewspaperPages, fetchNewspaperRSS, shouldPullJob };
