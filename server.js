#!/usr/bin/env node
/**
 * veille-submit — PWA to collect URLs from mobile and store them in PostgreSQL
 *
 * Features:
 * - Android Share Target (PWA) — share links directly from any app
 * - ntfy.sh subscription (SSE) — receive URLs via push notifications
 * - HTTP POST /submit — direct API endpoint
 * - YouTube: auto-fetches title + transcript via yt-dlp
 * - Articles: auto-fetches page title
 * - Duplicate detection
 * - Push notifications via ntfy on new submissions
 *
 * All config via environment variables — see .env.example
 */

const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

// ─── CONFIG (all from env) ───

const PORT = parseInt(process.env.PORT || '7890', 10);
const DB_SCHEMA = process.env.DB_SCHEMA || 'veille';
const DB_TABLE = process.env.DB_TABLE || 'feed_items';
const AGENT_ID = parseInt(process.env.AGENT_ID || '1', 10);
const API_TOKEN = process.env.API_TOKEN || '';

// Validate SQL identifiers to prevent injection via env vars
function assertSafeId(val, name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) throw new Error(`Unsafe identifier in ${name}: "${val}"`);
}
assertSafeId(DB_SCHEMA, 'DB_SCHEMA');
assertSafeId(DB_TABLE, 'DB_TABLE');

// HTML escape for template rendering
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ntfy — subscription channel (receive URLs)
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const NTFY_SUBSCRIBE_TOPIC = process.env.NTFY_SUBSCRIBE_TOPIC || '';
const NTFY_AUTH_USER = process.env.NTFY_AUTH_USER || '';
const NTFY_AUTH_PASS = process.env.NTFY_AUTH_PASS || '';

// ntfy — notification channel (send confirmations)
const NTFY_NOTIFY_TOPIC = process.env.NTFY_NOTIFY_TOPIC || '';
const NTFY_NOTIFY_SERVER = process.env.NTFY_NOTIFY_SERVER || NTFY_SERVER;

// App name (shown in UI)
const APP_NAME = process.env.APP_NAME || 'Veille Submit';

// PostgreSQL — uses standard PG* env vars
const pg = new Pool({ max: 3 });

function ntfyAuthHeaders() {
  const h = {};
  if (NTFY_AUTH_USER && NTFY_AUTH_PASS) {
    h['Authorization'] = 'Basic ' + Buffer.from(NTFY_AUTH_USER + ':' + NTFY_AUTH_PASS).toString('base64');
  }
  return h;
}

// ─── URL TYPE DETECTION ───

function detectUrlType(url) {
  url = url.trim();
  if (/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/.test(url)) return { type: 'youtube', url };
  if (/instagram\.com\/(reel|p|reels)\//.test(url)) return { type: 'instagram', url };
  if (/tiktok\.com/.test(url)) return { type: 'tiktok', url };
  if (/(?:twitter\.com|x\.com)\//.test(url)) return { type: 'twitter', url };
  if (/linkedin\.com/.test(url)) return { type: 'linkedin', url };
  if (/^https?:\/\//.test(url)) return { type: 'article', url };
  return null;
}

function extractVideoId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─── YOUTUBE (requires yt-dlp) ───

function getVideoTranscript(videoId) {
  return new Promise((resolve) => {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return resolve(null);
    const tmpDir = '/tmp/subs_' + videoId + '_' + Date.now();
    fs.mkdirSync(tmpDir, { recursive: true });
    const args = [
      '--write-auto-sub', '--write-sub', '--sub-lang', 'en,fr',
      '--skip-download', '--sub-format', 'vtt',
      '-o', tmpDir + '/%(id)s.%(ext)s',
      'https://www.youtube.com/watch?v=' + videoId
    ];
    execFile('yt-dlp', args, { timeout: 45000 }, () => {
      try {
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt'));
        if (files.length === 0) return resolve(null);
        const vtt = fs.readFileSync(tmpDir + '/' + files[0], 'utf8');
        const seen = new Set();
        const parts = [];
        for (const line of vtt.split('\n')) {
          if (!line.trim() || line.startsWith('WEBVTT') || line.startsWith('Kind:') ||
              line.startsWith('Language:') || line.includes('-->') || /^\d+$/.test(line.trim())) continue;
          const clean = line.replace(/<[^>]+>/g, '').trim();
          if (clean.length > 0 && !seen.has(clean)) { seen.add(clean); parts.push(clean); }
        }
        const result = parts.join(' ').replace(/\s+/g, ' ').trim();
        resolve(result.length > 50 ? result : null);
      } catch (e) { resolve(null); }
      finally { try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {} }
    });
  });
}

function getYouTubeTitle(videoId) {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--print', 'title', '--no-download',
      'https://www.youtube.com/watch?v=' + videoId],
      { timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

// ─── FETCH ARTICLE TITLE ───

function fetchPageTitle(url, depth = 0) {
  if (depth > 5) return Promise.resolve(null);
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VeilleBot/1.0)' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPageTitle(res.headers.location, depth + 1).then(resolve);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 50000) res.destroy(); });
      res.on('end', () => {
        const m = data.match(/<title[^>]*>([^<]+)<\/title>/i);
        resolve(m ? m[1].trim() : null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── PROCESS SUBMISSION ───

async function processSubmission(url, submittedVia) {
  const detection = detectUrlType(url);
  if (!detection) return { success: false, error: 'Unrecognized URL: ' + url };

  console.log('[SUBMIT] Processing ' + detection.type + ': ' + detection.url + ' (via ' + submittedVia + ')');

  const table = DB_SCHEMA + '.' + DB_TABLE;

  // Duplicate check
  const existing = await pg.query(
    `SELECT id, title FROM ${table} WHERE source_url = $1 AND agent_id = $2`,
    [detection.url, AGENT_ID]
  );
  if (existing.rows.length > 0) {
    const msg = 'Already tracked: "' + existing.rows[0].title + '"';
    console.log('[SUBMIT] ' + msg);
    return { success: true, duplicate: true, message: msg, item_id: existing.rows[0].id };
  }

  let title = null, summary = null, imageUrl = null;

  if (detection.type === 'youtube') {
    const videoId = extractVideoId(detection.url);
    if (videoId) {
      title = await getYouTubeTitle(videoId);
      const transcript = await getVideoTranscript(videoId);
      summary = transcript ? transcript.substring(0, 500) + '...' : null;
      imageUrl = 'https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg';
    }
  } else if (detection.type === 'instagram') {
    title = 'Instagram Reel (manual submit)';
  } else if (detection.type === 'article') {
    title = await fetchPageTitle(detection.url);
  }

  if (!title) {
    title = detection.type.charAt(0).toUpperCase() + detection.type.slice(1) + ' - ' +
      new Date().toISOString().split('T')[0];
  }

  const result = await pg.query(
    `INSERT INTO ${table}
     (agent_id, source_id, source_type, source_url, title, summary, relevance_score, review_status, image_url)
     VALUES ($1, NULL, $2, $3, $4, $5, 5.0, 'pending', $6)
     RETURNING id`,
    [AGENT_ID, detection.type, detection.url, title, summary, imageUrl]
  );

  const itemId = result.rows[0].id;
  console.log('[SUBMIT] Inserted #' + itemId + ': "' + title + '"');

  return {
    success: true, duplicate: false, item_id: itemId,
    title, type: detection.type,
    message: 'Added: "' + title.substring(0, 60) + '"'
  };
}

// ─── NTFY NOTIFICATIONS ───

function sendNotification(message, title) {
  if (!NTFY_NOTIFY_TOPIC) return;
  const url = new URL('/' + NTFY_NOTIFY_TOPIC, NTFY_NOTIFY_SERVER);
  const mod = url.protocol === 'https:' ? https : http;
  const req = mod.request(url, {
    method: 'POST',
    headers: { 'Title': title || APP_NAME, 'Priority': 'high', 'Tags': 'mag', ...ntfyAuthHeaders() },
    timeout: 5000
  }, (res) => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => console.log('[NTFY] Sent:', res.statusCode, title));
  });
  req.on('error', (e) => console.error('[NTFY] Error:', e.message));
  req.write(message);
  req.end();
}

// ─── NTFY SUBSCRIBER (SSE) ───

function subscribeNtfy() {
  if (!NTFY_SUBSCRIBE_TOPIC) { console.log('[NTFY] No subscribe topic configured, skipping'); return; }

  const url = NTFY_SERVER + '/' + NTFY_SUBSCRIBE_TOPIC + '/sse';
  console.log('[NTFY] Subscribing to ' + url);

  const mod = url.startsWith('https') ? https : http;
  const req = mod.get(url, {
    headers: { 'Accept': 'text/event-stream', ...ntfyAuthHeaders() },
    timeout: 0
  }, (res) => {
    console.log('[NTFY] Connected (status ' + res.statusCode + ')');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.substring(6));
            if (event.event === 'message' && event.message) handleNtfyMessage(event.message);
          } catch (e) {}
        }
      }
    });
    res.on('end', () => { console.log('[NTFY] Disconnected, reconnecting in 5s...'); setTimeout(subscribeNtfy, 5000); });
  });
  req.on('error', (err) => { console.error('[NTFY] Error:', err.message, '- reconnecting in 10s...'); setTimeout(subscribeNtfy, 10000); });
}

async function handleNtfyMessage(message) {
  console.log('[NTFY] Received: ' + message.substring(0, 200));
  const urls = message.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g);
  if (!urls || urls.length === 0) {
    sendNotification('No URL found in: "' + message.substring(0, 100) + '"', APP_NAME + ' - Error');
    return;
  }
  for (const url of urls) {
    try {
      const result = await processSubmission(url, 'ntfy');
      if (result.success) sendNotification(result.message, APP_NAME + ' - ' + (result.duplicate ? 'Duplicate' : 'Added'));
      else sendNotification(result.error, APP_NAME + ' - Error');
    } catch (e) {
      console.error('[NTFY] Processing error:', e.message);
      sendNotification('Error: ' + e.message, APP_NAME + ' - Error');
    }
  }
}

// ─── STATIC FILES ───

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  } catch (e) {
    try {
      const idx = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(idx);
    } catch (e2) { res.writeHead(404); res.end('Not found'); }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}

// ─── HTTP SERVER ───

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlObj = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;

  // Health check
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ─── SHARE TARGET (GET — Android share sheet) ───
  if (req.method === 'GET' && pathname === '/share') {
    const raw = urlObj.searchParams.get('url') || urlObj.searchParams.get('text') || urlObj.searchParams.get('title') || '';
    const urlMatch = String(raw).match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/);
    console.log('[SHARE] raw=' + raw.substring(0, 200));

    // Respond immediately — process in background
    const hasUrl = !!urlMatch;
    const sharedUrl = hasUrl ? urlMatch[0] : '';
    const icon = hasUrl ? '&#x2705;' : '&#x274C;';
    const msg = hasUrl ? 'Sent to ' + APP_NAME : 'No URL detected';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(APP_NAME)}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f23;color:#fff}
.card{text-align:center;padding:2rem;max-width:90vw;animation:pop .3s ease}
@keyframes pop{0%{transform:scale(.8);opacity:0}100%{transform:scale(1);opacity:1}}
.icon{font-size:4rem;margin-bottom:1rem}.msg{font-size:1.3rem;font-weight:600;margin-bottom:.5rem}
.url{font-size:.75rem;color:#888;word-break:break-all;max-width:300px;margin:0 auto 1.5rem}
.hint{font-size:.8rem;color:#666;margin-top:1rem}
</style></head><body>
<div class="card"><div class="icon">${icon}</div><div class="msg">${esc(msg)}</div>
<div class="url">${esc(sharedUrl.substring(0, 120))}</div>
<div class="hint">Closing automatically...</div></div>
<script>setTimeout(()=>{try{window.close()}catch(e){history.back()}},2000)</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

    if (hasUrl) {
      processSubmission(sharedUrl, 'share-sheet').then(result => {
        if (result.success && !result.duplicate) sendNotification(result.message, APP_NAME + ' - Added');
      }).catch(e => console.error('[SHARE] Background error:', e.message));
    }
    return;
  }

  // ─── SHARE TARGET (POST fallback) ───
  if (req.method === 'POST' && pathname === '/share') {
    const body = await readBody(req);
    const ct = req.headers['content-type'] || '';
    let shared = {};
    if (ct.includes('x-www-form-urlencoded')) shared = querystring.parse(body);
    else if (ct.includes('json')) { try { shared = JSON.parse(body); } catch(e) {} }

    const raw = shared.url || shared.text || shared.title || body;
    const urlMatch = String(raw).match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/);

    if (urlMatch) {
      processSubmission(urlMatch[0], 'share-sheet').then(result => {
        if (result.success && !result.duplicate) sendNotification(result.message, APP_NAME + ' - Added');
      }).catch(e => console.error('[SHARE] Error:', e.message));
    }

    res.writeHead(303, { 'Location': urlMatch ? '/?shared=1&status=ok' : '/?shared=1&status=no_url' });
    res.end();
    return;
  }

  // ─── AUTH CHECK (optional API_TOKEN) ───
  if (API_TOKEN && (pathname === '/submit' || pathname === '/share') && req.headers['authorization'] !== 'Bearer ' + API_TOKEN) {
    // Share target from browser won't have auth header — check cookie fallback
    const cookies = req.headers.cookie || '';
    const hasValidCookie = cookies.includes('auth_session='); // reverse proxy sets this
    if (!hasValidCookie && pathname === '/submit') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — set API_TOKEN in .env or use Bearer auth' }));
      return;
    }
  }

  // ─── SUBMIT (API) ───
  if (req.method === 'POST' && pathname === '/submit') {
    const body = await readBody(req);
    try {
      let url;
      const ct = req.headers['content-type'] || '';
      if (ct.includes('json')) { const d = JSON.parse(body); url = d.url || d.text || d.link; }
      else { const m = body.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/); url = m ? m[0] : body.trim(); }

      if (!url) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No URL provided' })); return; }

      const result = await processSubmission(url, 'http');
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      if (result.success && !result.duplicate) sendNotification(result.message, APP_NAME + ' - Added');
    } catch (e) {
      console.error('[HTTP] Error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── RECENT ITEMS ───
  if (req.method === 'GET' && pathname === '/recent') {
    try {
      const table = DB_SCHEMA + '.' + DB_TABLE;
      const items = await pg.query(
        `SELECT id, source_type, source_url, title, relevance_score, review_status, created_at
         FROM ${table} WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [AGENT_ID]
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: items.rows }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── STATIC FILES (PWA) ───
  if (req.method === 'GET') { serveStatic(req, res); return; }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[veille-submit] Listening on port ' + PORT);
  subscribeNtfy();
});

process.on('SIGTERM', () => { server.close(); pg.end(); process.exit(0); });
process.on('SIGINT', () => { server.close(); pg.end(); process.exit(0); });
