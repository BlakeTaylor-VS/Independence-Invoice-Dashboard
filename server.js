const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

// ── Date Sent store ──────────────────────────────────────────────────────────
// Persists the date Christine actually emails each invoice, keyed by invoice #.
// This lives OUTSIDE index.html/SEED on purpose: the QuickBooks sync process
// overwrites the entire SEED array in index.html on every refresh, so anything
// stored inside that file would be wiped out. Use a Render persistent disk
// mounted at /var/data if available; falls back to a local ./data folder for
// local dev (without a persistent disk on Render, this file will NOT survive
// a redeploy — see README note).
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Independence Health Invoice Dashboard running on port ${PORT}`);
  console.log(`Date Sent store: ${DATE_SENT_FILE}`);
});
