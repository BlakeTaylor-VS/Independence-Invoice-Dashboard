const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Date Sent store ──────────────────────────────────────────────────────────
// Persists the date Christine actually emails each invoice, keyed by invoice #.
// This lives OUTSIDE index.html/SEED on purpose: the automated QuickBooks
// "refresh" process periodically regenerates large portions of index.html
// (not just the SEED array), so anything stored inside that file gets wiped
// out. Use a Render persistent disk mounted at /var/data if available; falls
// back to a local ./data folder for local dev (without a persistent disk on
// Render, this file will NOT survive a redeploy).
const DISK_DIR = fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data');
try { fs.mkdirSync(DISK_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const DATE_SENT_FILE = path.join(DISK_DIR, 'date-sent.json');

function loadDateSent() {
  try { return JSON.parse(fs.readFileSync(DATE_SENT_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveDateSent(data) {
  fs.writeFileSync(DATE_SENT_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/date-sent', (req, res) => {
  res.json(loadDateSent());
});

app.post('/api/date-sent', (req, res) => {
  const { num, sentDate } = req.body || {};
  if (!num) return res.status(400).json({ message: 'num is required' });
  const data = loadDateSent();
  if (!sentDate) delete data[num];
  else data[num] = sentDate;
  saveDateSent(data);
  res.json({ ok: true, dateSent: data });
});

// ── Serve index.html with our fix injected ────────────────────────────────────
// IMPORTANT: the automated QuickBooks "refresh" process regenerates index.html
// from an older template on every sync, silently wiping out manual code edits
// made directly in that file (this has happened twice already — see app-fix.js
// for the full explanation). So instead of editing index.html's own <script>,
// all Date Sent / late-fee-formula / email-template fixes live in app-fix.js,
// and THIS route injects a <script src="/app-fix.js"> tag into whatever
// index.html currently contains, every time the page is served. That way the
// fix survives no matter what the refresh process does to index.html, as long
// as this route (in server.js, which the refresh process never touches) keeps
// running and index.html still has a closing </body> tag.
function serveIndexWithFix(req, res) {
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  } catch (e) {
    return res.status(500).send('index.html not found');
  }
  if (!html.includes('/app-fix.js')) {
    if (html.includes('</body>')) {
      html = html.replace('</body>', '  <script src="/app-fix.js"></script>\n</body>');
    } else {
      html += '\n<script src="/app-fix.js"></script>\n';
    }
  }
  res.set('Content-Type', 'text/html');
  res.send(html);
}

app.get('/', serveIndexWithFix);
app.get('/index.html', serveIndexWithFix);

// Serve app-fix.js, styles, and any other static assets. Registered AFTER the
// routes above so it never preempts the injection for '/' or '/index.html'.
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Independence Health Invoice Dashboard running on port ${PORT}`);
  console.log(`Date Sent store: ${DATE_SENT_FILE}`);
});
