// ── APP-FIX.JS ────────────────────────────────────────────────────────────────
// IMPORTANT: this file exists because the automated QuickBooks "refresh" process
// (triggered via the "Ask Claude to Refresh" button / openClaudeRefresh()) does
// not just patch the invoice data — it periodically regenerates large portions
// of index.html from an older template, silently wiping out manual code fixes
// made directly in index.html (this has already happened twice: Sep 2 and Sep 4
// 2026 syncs both reverted the late-fee logic and deleted the Date Sent feature
// entirely). index.html is NOT a safe place for custom logic anymore.
//
// This file is loaded by server.js, which injects <script src="/app-fix.js">
// right before </body> on every request — regardless of what index.html's own
// content looks like. The refresh process only ever touches index.html, never
// server.js or this file, so everything below survives refreshes indefinitely.
//
// Do NOT move this logic back into index.html. If a future change is needed,
// edit THIS file (and server.js if needed), not index.html's inline <script>.

(function () {

  // ── DATE SENT ──────────────────────────────────────────────────────────────
  // Christine manually confirms the date she actually emails each invoice.
  // Stored server-side (keyed by invoice #) via /api/date-sent so it's shared
  // between her and Joe and survives both browser refreshes and QB re-syncs.
  // Once set, it becomes the official start of the 30-day due-date clock — the
  // Due Date column and every overdue/late-fee calculation recompute from it.
  window.SENT_DATES = {};

  function fmtDateStr(d) { return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear(); }
  function addDays(dateStr, n) { const d = toDate(dateStr); d.setDate(d.getDate() + n); return fmtDateStr(d); }
  function toInputDate(mdY) { if (!mdY) return ''; const [m, d, y] = mdY.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  function fromInputDate(yMd) { const [y, m, d] = yMd.split('-'); return `${m}/${d}/${y}`; }

  window.addDays = addDays;

  async function loadSentDates() {
    try {
      const res = await fetch('/api/date-sent');
      window.SENT_DATES = res.ok ? await res.json() : {};
    } catch (e) { window.SENT_DATES = {}; }
    applySentDates();
  }
  window.loadSentDates = loadSentDates;

  function applySentDates() {
    DATA.forEach(r => {
      const s = window.SENT_DATES[r.num];
      if (s) { r.sent = s; r.due = addDays(s, 30); }
      else { delete r.sent; }
    });
  }
  window.applySentDates = applySentDates;

  function sentCellHTML(r) {
    const val = r.sent || '';
    return `<input type="date" class="sent-date-input" value="${toInputDate(val)}" onclick="event.stopPropagation()" onchange="saveSentDate('${r.num}', this.value)" title="Date this invoice was emailed to the agency">`;
  }
  window.sentCellHTML = sentCellHTML;

  async function saveSentDate(num, inputValue) {
    const sentDate = inputValue ? fromInputDate(inputValue) : '';
    try {
      await fetch('/api/date-sent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ num, sentDate }) });
      if (sentDate) window.SENT_DATES[num] = sentDate; else delete window.SENT_DATES[num];
      applySentDates();
      renderDashboard();
      if (document.getElementById('tab-agency') && document.getElementById('tab-agency').classList.contains('active')) renderAgencyView();
      showToast(sentDate ? `Date sent saved for invoice #${num} ✓` : `Date sent cleared for invoice #${num}`);
    } catch (e) { showToast('Could not save date sent — check connection', 'var(--rust)'); }
  }
  window.saveSentDate = saveSentDate;

  // Inject the input's styling once (index.html's own stylesheet may or may not
  // carry this, depending on whether a refresh stripped it).
  if (!document.getElementById('app-fix-style')) {
    const style = document.createElement('style');
    style.id = 'app-fix-style';
    style.textContent = `.sent-date-input { font-family: var(--sans, sans-serif); font-size: 12px; border: 1px solid #ddd; border-radius: 4px; padding: 3px 5px; background: #fff; color: #111; width: 130px; }`;
    document.head.appendChild(style);
  }

  // ── LATE FEE FORMULA (overrides index.html's version) ────────────────────────
  // Per contract terms: once an invoice is past due, a $50 fee is added for
  // every full week it remains unpaid, then a single 3% fee is charged on top
  // of the resulting balance (original invoice + accrued weekly fees). The 3%
  // is a one-time surcharge recalculated fresh against the current balance
  // each time — it does not compound on top of itself week over week.
  window.calcLateFee = function calcLateFee(openAmount, days) {
    if (days < 1) return { fees: 0, total: openAmount };
    const weeksLate = Math.floor(days / 7);
    const subtotal = openAmount + 50 * weeksLate;
    const total = subtotal * 1.03;
    return { fees: total - openAmount, total };
  };

  // ── EMAIL TEMPLATE (overrides index.html's version) ───────────────────────────
  // Switches to the past-due/late-fee template starting day 1 overdue (not day
  // 30), and aligns escalation tiers to 30/40/50/60 days past due — matching
  // the text-message templates and the day-count badges.
  window.buildAgencyEmail = function buildAgencyEmail(agencyName, invoices) {
    const totalOpen = invoices.reduce((s, r) => s + r.open, 0);
    const maxDays = agencyMaxDays(invoices);
    const totalFmt = fmt(totalOpen);
    const isPastDue = maxDays >= 1;
    const rowColor = isPastDue ? '#b91c1c' : '#15803d';
    let totalWithFees = 0;
    const rows = invoices.map(r => {
      const days = daysOverdue(r.due);
      const statusLabel = days > 0 ? `${days} days overdue` : `Due in ${Math.abs(days)} days`;
      const feeCalc = calcLateFee(r.open, days);
      totalWithFees += feeCalc.total;
      if (isPastDue) return `<tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">Invoice #${r.num}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">Due: ${r.due}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">${statusLabel}</td><td style="padding:6px 10px;color:${rowColor};">Original Open: ${fmt(r.open)}</td><td style="padding:6px 10px;color:${rowColor};">Late Fees: ${fmt(feeCalc.fees)}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">New Total: ${fmt(feeCalc.total)}</td></tr>`;
      return `<tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">Invoice #${r.num}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">Due: ${r.due}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">Billed: ${fmt(r.amount)}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">Open: ${fmt(r.open)}</td><td style="padding:6px 10px;color:${rowColor};font-weight:bold;">${statusLabel}</td></tr>`;
    }).join('');
    const tableHeader = isPastDue ? `<tr style="background:#f3f4f6;"><th style="padding:7px 10px;text-align:left;">Invoice</th><th style="padding:7px 10px;text-align:left;">Due Date</th><th style="padding:7px 10px;text-align:left;">Status</th><th style="padding:7px 10px;text-align:left;">Original Open</th><th style="padding:7px 10px;text-align:left;">Late Fees Accrued</th><th style="padding:7px 10px;text-align:left;">New Total Due</th></tr>` : `<tr style="background:#f3f4f6;"><th style="padding:7px 10px;text-align:left;">Invoice</th><th style="padding:7px 10px;text-align:left;">Due Date</th><th style="padding:7px 10px;text-align:left;">Billed</th><th style="padding:7px 10px;text-align:left;">Open Balance</th><th style="padding:7px 10px;text-align:left;">Status</th></tr>`;
    const invoiceTable = `<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;margin:10px 0;"><thead>${tableHeader}</thead><tbody>${rows}</tbody></table><p style="font-family:Arial,sans-serif;font-size:13px;color:${rowColor};font-weight:bold;">Total Outstanding (Original): ${totalFmt}${isPastDue ? ` &nbsp;|&nbsp; Total With Late Fees: ${fmt(totalWithFees)}` : ''}</p>`;
    // Early payment discount notice permanently removed per Blake's instruction
    // (2026-09) — it should never appear on any drafted email.
    const lateFeeNotice = `<p style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#b91c1c;margin:16px 0;padding:12px 16px;border:2px solid #b91c1c;border-radius:6px;">LATE FEE NOTICE: Per the Invoicing and Payment Terms of your signed contract, a $50.00 fee is added for every full week an invoice remains unpaid past its due date, plus a 3% fee on the resulting balance, until paid in full.</p>`;
    const sig = `<p style="font-family:Arial,sans-serif;font-size:13px;margin-top:24px;">Sincerely,<br><strong>Christine Woods</strong><br>Accounts Receivable Manager | Independence Health Contractors<br>AP@independencehealthc.com | (513) 532-9819</p>`;
    const base = `font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:680px;`;
    if (maxDays >= 60) return { subject: `SERVICE SUSPENSION NOTICE - ${agencyName} - ${totalFmt} Outstanding - ${maxDays}+ Days Overdue`, body: `<div style="${base}"><p>Dear ${agencyName} Billing / Leadership,</p><p>The outstanding invoices below have now exceeded 60 days past due. Independence Health Contractors is formally suspending acceptance of all new patient referrals from ${agencyName}.</p>${invoiceTable}${lateFeeNotice}${sig}</div>` };
    if (maxDays >= 50) return { subject: `FINAL NOTICE - ${agencyName} - ${totalFmt} Outstanding - ${maxDays} Days Past Due`, body: `<div style="${base}"><p>Dear ${agencyName} Billing Team,</p><p>Final notice: the outstanding balance below has reached ${maxDays} days past due. If this is not resolved within 10 business days, we will be required to suspend acceptance of new patient referrals from ${agencyName}.</p>${invoiceTable}${lateFeeNotice}${sig}</div>` };
    if (maxDays >= 40) return { subject: `URGENT PAST DUE NOTICE - ${agencyName} - ${totalFmt} Outstanding - ${maxDays} Days Past Due`, body: `<div style="${base}"><p>Dear ${agencyName} Billing Team,</p><p>This is an urgent follow-up: the outstanding balance below has reached ${maxDays} days past due and requires immediate attention. Please respond within 10 business days.</p>${invoiceTable}${lateFeeNotice}${sig}</div>` };
    if (maxDays >= 30) return { subject: `Independence Past Due Invoice Notice - ${agencyName} - ${totalFmt} Outstanding`, body: `<div style="${base}"><p>Dear ${agencyName} Billing Team,</p><p>The invoices below have passed their 30-day due date and require your immediate attention.</p>${invoiceTable}${lateFeeNotice}${sig}</div>` };
    if (maxDays >= 1) return { subject: `Independence Past Due Invoice Notice - ${agencyName} - ${totalFmt} Outstanding`, body: `<div style="${base}"><p>Dear ${agencyName} Billing Team,</p><p>The invoices below are now past due. Please remit payment at your earliest convenience.</p>${invoiceTable}${lateFeeNotice}${sig}</div>` };
    return { subject: `New Independence Invoice - ${agencyName} - ${totalFmt}`, body: `<div style="${base}"><p>Good afternoon,</p><p>Please find below our invoice summary for services provided.</p>${invoiceTable}${sig}</div>` };
  };

  // ── UI PATCHING ────────────────────────────────────────────────────────────
  // Rather than re-implementing renderDashboard/renderAgencyView from scratch
  // (which would have to be kept in sync with index.html's version forever),
  // wrap the originals and patch the Date Sent column/cells into the DOM they
  // produce. This keeps working even if index.html's markup shifts slightly.

  function ensureInvoiceTableHeader() {
    const headRow = document.querySelector('.table-wrap table thead tr');
    if (!headRow || headRow.querySelector('.date-sent-th')) return;
    const ths = headRow.querySelectorAll('th');
    // Column 2 (0-indexed) is "Contractor" in the base app; insert right after it.
    if (ths.length < 4) return;
    const th = document.createElement('th');
    th.className = 'date-sent-th';
    th.style.cursor = 'default';
    th.textContent = 'Date Sent';
    headRow.insertBefore(th, ths[3]);
  }

  function patchInvoiceRows() {
    const tbody = document.getElementById('table-body');
    if (!tbody) return;
    Array.from(tbody.rows).forEach(tr => {
      if (tr.cells.length < 4 || tr.classList.contains('no-results')) return;
      if (tr.querySelector('.date-sent-td')) return;
      const num = (tr.cells[1].textContent || '').trim();
      const row = DATA.find(r => r.num === num);
      const td = document.createElement('td');
      td.className = 'date-sent-td';
      td.innerHTML = row ? sentCellHTML(row) : '';
      tr.insertBefore(td, tr.cells[3]);
    });
  }

  const _origRenderDashboard = renderDashboard;
  window.renderDashboard = function () {
    _origRenderDashboard();
    ensureInvoiceTableHeader();
    patchInvoiceRows();
  };

  function patchAgencySubRows() {
    document.querySelectorAll('#agency-tbody tr.sub-row').forEach(tr => {
      if (tr.dataset.sentPatched) return;
      const invoiceCell = tr.cells[1];
      const dueCell = tr.cells[2];
      if (!invoiceCell || !dueCell) return;
      const m = invoiceCell.textContent.match(/#(\S+)/);
      if (!m) return;
      const row = DATA.find(r => r.num === m[1]);
      if (!row) return;
      dueCell.innerHTML = row.sent
        ? `Sent: ${row.sent} · Due: ${row.due}`
        : `<span style="color:#E8A020">⚠ Date sent not entered</span> · Due: ${row.due}`;
      tr.dataset.sentPatched = '1';
    });
  }

  const _origRenderAgencyView = renderAgencyView;
  window.renderAgencyView = function () {
    _origRenderAgencyView();
    patchAgencySubRows();
  };

  const _origSyncData = syncData;
  window.syncData = async function () {
    await _origSyncData();
    applySentDates();
    renderDashboard();
    if (document.getElementById('tab-agency') && document.getElementById('tab-agency').classList.contains('active')) renderAgencyView();
  };

  const _origResetProject = resetProject;
  window.resetProject = function () {
    _origResetProject();
    applySentDates();
    renderDashboard();
  };

  // ── INIT ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async function () {
    await loadSentDates();
