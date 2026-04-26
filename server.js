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
fs.mkdirSync(DATA_DIR, { recursive: true });

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
        post_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
      `);
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

const rssParser = new Parser({ timeout: 12000 });
const keywords = (process.env.JOB_KEYWORDS || 'warehouse,data entry,customer service,office admin,clerical,receptionist,call center,driver,delivery,security,retail,no experience,entry level')
  .split(',').map(s => s.trim()).filter(Boolean);
const fetchCron = process.env.FETCH_CRON || '0 * * * *';
const newspaperFetchCron = process.env.NEWSPAPER_FETCH_CRON || '0 8,20 * * *';
const newspaperFeeds = (process.env.NEWSPAPER_RSS_FEEDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const newspaperPages = (process.env.NEWSPAPER_PAGE_URLS || 'https://patch.com/new-jersey/across-nj/localjobs,https://jobs.nj.com/careers/jobsearch')
  .split(',').map(s => s.trim()).filter(Boolean);
const pullTitleKeywords = (process.env.PULL_TITLE_KEYWORDS || 'warehouse,data entry,customer service,office,admin,clerical,receptionist,call center,driver,delivery,retail,cashier,stock,shipping,receiving,forklift,packer,picker')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const excludedTitlePattern = /\b(senior|principal|engineer|developer|software|cloud|devops|architect|scientist)\b/i;

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
  return `NOW HIRING - NEW JERSEY\n\nJob: ${job.title || 'Job Opening'}\nCompany: ${job.company || 'Company not listed'}\nLocation: ${job.location || 'New Jersey'}${salary}\n\nCategory: ${job.category || 'General'}\nApply / details: ${job.url}\n\n${footer}`;
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
  const record = { ...job, external_id, category: job.category || detectCategory(job.title, job.description) };
  record.post_text = buildPost(record);
  if (existing) return false;
  runSql(database, `INSERT INTO jobs (source,external_id,title,company,location,salary,description,url,category,date_posted,post_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
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
      record.post_text
    ]);
  persistDb();
  return true;
}

async function fetchAdzuna() {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return { source: 'adzuna', added: 0, skipped: 'missing keys' };
  let added = 0;
  for (const kw of keywords.slice(0, 10)) {
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}&where=New%20Jersey&what=${encodeURIComponent(kw)}&results_per_page=20&sort_by=date`;
    const res = await fetch(url); if (!res.ok) continue;
    const data = await res.json();
    for (const j of (data.results || [])) {
      if (await upsertJob({ source:'Adzuna', external_id:`adzuna:${j.id}`, title:j.title, company:j.company?.display_name || '', location:j.location?.display_name || 'New Jersey', salary: j.salary_min ? `$${Math.round(j.salary_min).toLocaleString()}+` : '', description: clean(j.description || '').slice(0,500), url:j.redirect_url, date_posted:j.created })) added++;
    }
  }
  return { source: 'adzuna', added };
}

async function fetchUSAJobs() {
  const auth = process.env.USAJOBS_AUTH_KEY, ua = process.env.USAJOBS_USER_AGENT;
  if (!auth || !ua) return { source: 'usajobs', added: 0, skipped: 'missing keys' };
  const url = 'https://data.usajobs.gov/api/Search?LocationName=New%20Jersey&ResultsPerPage=50&DatePosted=30&SortField=OpenDate&SortDirection=Desc';
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Authorization-Key': auth, 'Host': 'data.usajobs.gov' } });
  if (!res.ok) return { source: 'usajobs', added: 0, error: res.statusText };
  const data = await res.json(); let added = 0;
  for (const item of data.SearchResult?.SearchResultItems || []) {
    const d = item.MatchedObjectDescriptor || {};
    if (await upsertJob({ source:'USAJOBS', external_id:`usajobs:${d.PositionID}`, title:d.PositionTitle, company:d.OrganizationName, location:(d.PositionLocation || []).map(x=>x.LocationName).join(', ') || 'New Jersey', salary:d.PositionRemuneration?.[0]?.MinimumRange ? `$${d.PositionRemuneration[0].MinimumRange} - $${d.PositionRemuneration[0].MaximumRange}` : '', description: clean(d.QualificationSummary || '').slice(0,500), url:d.PositionURI, date_posted:d.PublicationStartDate })) added++;
  }
  return { source: 'usajobs', added };
}

async function fetchJooble() {
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
        location: 'New Jersey',
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
        external_id: `jooble:${j.id || j.link}`,
        title,
        company: j.company || '',
        location: j.location || 'New Jersey',
        salary: j.salary || '',
        description,
        url: j.link || '',
        date_posted: j.updated || ''
      })) added++;
    }
  }

  return { source: 'jooble', added, checked };
}

async function fetchTheMuse() {
  let added = 0;
  let checked = 0;

  for (let page = 1; page <= 3; page++) {
    const url = `https://www.themuse.com/api/public/jobs?page=${page}&location=${encodeURIComponent('New Jersey')}`;
    const res = await fetch(url);
    if (!res.ok) return { source: 'themuse', added, checked, error: res.statusText };

    const data = await res.json();
    const jobs = data.results || [];
    checked += jobs.length;

    for (const j of jobs) {
      const description = clean(j.contents || '').slice(0, 500);
      if (!shouldPullJob(j.name, description)) continue;

      const locations = (j.locations || []).map(location => location.name).join(', ') || 'New Jersey';
      const company = j.company?.name || '';
      const url = j.refs?.landing_page || j.refs?.landingPage || '';

      if (await upsertJob({
        source: 'The Muse',
        external_id: `themuse:${j.id}`,
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

async function fetchRSS() {
  const feeds = [
    'https://www.njlm.org/RSSFeed.aspx?ModID=7&CID=All-government-jobs-4',
    ...(process.env.EXTRA_RSS_FEEDS || '').split(',').map(s=>s.trim()).filter(Boolean)
  ];
  let added = 0, results = [];
  for (const feed of feeds) {
    try {
      const parsed = await rssParser.parseURL(feed);
      for (const item of parsed.items || []) {
        const text = clean(item.contentSnippet || item.content || item.summary || '');
        const loc = /\b(NJ|New Jersey)\b/i.test(`${item.title} ${text}`) ? 'New Jersey' : '';
        if (await upsertJob({ source:'RSS', external_id:`rss:${item.guid || item.link || item.title}`, title:clean(item.title), company:parsed.title || 'Job Board', location:loc || 'New Jersey', salary:'', description:text.slice(0,500), url:item.link, date_posted:item.isoDate || item.pubDate || '' })) added++;
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

async function runFetch() {
  const results = [];
  results.push(await fetchJooble());
  results.push(await fetchTheMuse());
  results.push(await fetchRSS());
  results.push(await fetchAdzuna());
  results.push(await fetchUSAJobs());
  return results;
}

function requireAdmin(req,res,next){
  const configuredPassword = (process.env.ADMIN_PASSWORD || '').trim();
  const pass = req.headers['x-admin-password'] || req.query.password;
  if (!configuredPassword || pass === configuredPassword) return next();
  res.status(401).json({ error:'Admin password required' });
}

app.post('/api/fetch', requireAdmin, async (req,res)=> res.json({ results: await runFetch() }));
app.post('/api/fetch-newspapers', requireAdmin, async (req,res)=> res.json({ results: await runNewspaperFetch() }));
app.get('/api/jobs', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const status = req.query.status || 'new';
  const rows = queryAll(database, 'SELECT * FROM jobs WHERE status=? ORDER BY created_at DESC LIMIT 300', [status]);
  res.json(rows);
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
app.get('/api/export.csv', requireAdmin, async (req,res)=>{
  const database = await getDb();
  const rows = queryAll(database, 'SELECT title,company,location,salary,category,url,status,created_at,post_text FROM jobs ORDER BY created_at DESC');
  const csv = ['Title,Company,Location,Salary,Category,URL,Status,Created,Post Text', ...rows.map(r => Object.values(r).map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv'); res.send(csv);
});
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

if (require.main === module) {
  getDb().then(() => {
    cron.schedule(fetchCron, () => runFetch().catch(console.error));
    cron.schedule(newspaperFetchCron, () => runNewspaperFetch().catch(console.error));
    app.listen(PORT, ()=> console.log(`NJ Job Auto Poster running on ${PORT}; fetch schedule: ${fetchCron}; newspaper schedule: ${newspaperFetchCron}`));
  }).catch(err => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
}

module.exports = { app, runFetch, runNewspaperFetch, buildPost, detectCategory, getDb, fetchJooble, fetchTheMuse, fetchNewspaperPages, fetchNewspaperRSS, shouldPullJob };
