import express from 'express';

const app = express();

// In-memory store for received emails (persists while server is running)
const receivedEmails = [];
const MAX_EMAILS = 200;


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Webhook endpoint ───────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body;

    if (event.type !== 'email.received') {
      return res.status(200).json({ ok: true });
    }

    const emailId = event.data?.email_id;
    const messageId = event.data?.message_id || '';
    const subject = event.data?.subject || '(no subject)';
    const from = event.data?.from || '';
    const to = event.data?.to || [];
    const receivedAt = event.data?.created_at || new Date().toISOString();

    // Extract email body and attachments from the webhook payload
    let html = event.data?.html || '';
    let text = event.data?.text || '';

    // Resend does NOT include attachment content in the webhook payload.
    // Each attachment has an `id` — fetch the actual bytes via the Resend API.
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const rawAttachments = event.data?.attachments || [];
    const attachments = await Promise.all(rawAttachments.map(async a => {
      let content = null;
      if (a.id && RESEND_API_KEY) {
        try {
          // Step 1: get the signed download_url for this attachment
          const meta = await fetch(
            `https://api.resend.com/emails/receiving/${emailId}/attachments/${a.id}`,
            { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } }
          );
          if (!meta.ok) throw new Error(`meta ${meta.status}: ${await meta.text()}`);
          const { download_url } = await meta.json();

          // Step 2: download the actual bytes from the signed URL
          const file = await fetch(download_url);
          if (!file.ok) throw new Error(`download ${file.status}`);
          const buf = await file.arrayBuffer();
          content = Buffer.from(buf).toString('base64');
          console.log(`📎 Fetched "${a.filename}" — ${buf.byteLength} bytes`);
        } catch (e) {
          console.warn(`📎 Error fetching "${a.filename}": ${e.message}`);
        }
      }
      return { filename: a.filename, content, contentType: a.content_type };
    }));

    const emailRecord = {
      id: emailId,
      messageId,
      subject,
      from,
      to,
      receivedAt,
      html,
      text,
      attachments,
      forwarded: false,
    };

    // Deduplicate: ignore if we've already processed this email_id
    if (receivedEmails.some(e => e.id === emailId)) {
      console.log(`⚠️  Duplicate webhook for email_id ${emailId} — ignored`);
      return res.status(200).json({ ok: true });
    }

    // Store email (cap at MAX_EMAILS)
    receivedEmails.unshift(emailRecord);
    if (receivedEmails.length > MAX_EMAILS) receivedEmails.pop();

    // Forward if it looks like a receipt/invoice
    const REVOLUT_EMAIL = process.env.REVOLUT_EMAIL;
    const SMTP_USER = process.env.SMTP_USER;

    if (REVOLUT_EMAIL && SMTP_USER) {
      try {
        const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sender: { email: SMTP_USER },
            to: [{ email: REVOLUT_EMAIL }],
            subject: `FWD: ${subject}`,
            htmlContent: html || `<pre>${text}</pre>`,
            ...(text && { textContent: text }),
            replyTo: { email: from },
            ...(attachments.some(a => a.content) && {
              attachment: attachments
                .filter(a => a.content)
                .map(a => ({ name: a.filename, content: a.content })),
            }),
          }),
        });
        if (!brevoRes.ok) throw new Error(await brevoRes.text());
        emailRecord.forwarded = true;
        console.log(`✅ Forwarded: "${subject}" to ${REVOLUT_EMAIL}`);
      } catch (e) {
        console.error('Failed to forward email:', e.message);
      }
    } else if (!REVOLUT_EMAIL || !SMTP_USER) {
      console.warn('REVOLUT_EMAIL or SMTP_USER not set — forwarding skipped');
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Inbox UI ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const rows = receivedEmails.map(e => `
    <tr onclick="loadEmail('${e.id}')" style="cursor:pointer" class="row" id="row-${e.id}">
      <td>${e.forwarded ? '✅' : '—'}</td>
      <td>${escHtml(e.from)}</td>
      <td>${escHtml(e.subject)}</td>
      <td>${new Date(e.receivedAt).toLocaleString()}</td>
    </tr>
  `).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Receipt Forwarder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #222; }
    header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1.2rem; font-weight: 600; }
    header span { font-size: 0.8rem; opacity: 0.6; }
    .container { display: flex; height: calc(100vh - 56px); }
    .sidebar { width: 55%; border-right: 1px solid #ddd; background: white; overflow-y: auto; }
    .preview { flex: 1; background: white; overflow-y: auto; padding: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { background: #f9f9f9; border-bottom: 2px solid #eee; padding: 10px 12px; text-align: left; font-weight: 600; color: #666; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
    tr.row:hover { background: #f0f7ff; }
    tr.selected { background: #e8f0fe !important; }
    .empty { padding: 40px; text-align: center; color: #999; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .badge-fwd { background: #d4edda; color: #155724; }
    .badge-skip { background: #f8f9fa; color: #6c757d; }
    #preview-frame { width: 100%; border: none; height: 100%; min-height: 400px; }
    .meta { font-size: 0.8rem; color: #666; margin-bottom: 16px; line-height: 1.8; }
    .meta strong { color: #333; }
    .preview-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #bbb; font-size: 0.9rem; }
  </style>
</head>
<body>
  <header>
    <div>📬</div>
    <h1>Receipt Forwarder — Inbox</h1>
    <span>${receivedEmails.length} emails received</span>
  </header>
  <div class="container">
    <div class="sidebar">
      ${receivedEmails.length === 0 ? `<div class="empty">No emails yet.<br/>Forward something to your Resend inbound address.</div>` : `
      <table>
        <thead><tr><th>Fwd</th><th>From</th><th>Subject</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
    </div>
    <div class="preview" id="preview">
      <div class="preview-placeholder">Select an email to preview</div>
    </div>
  </div>
  <script>
    const emails = ${JSON.stringify(receivedEmails.map(e => ({ id: e.id, messageId: e.messageId, subject: e.subject, from: e.from, to: e.to, receivedAt: e.receivedAt, forwarded: e.forwarded, html: e.html, text: e.text })))};
    function escHtml(s) {
      return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function loadEmail(id) {
      document.querySelectorAll('tr.row').forEach(r => r.classList.remove('selected'));
      const row = document.getElementById('row-' + id);
      if (row) row.classList.add('selected');
      const e = emails.find(x => x.id === id);
      if (!e) return;
      const preview = document.getElementById('preview');
      preview.innerHTML = \`
        <div class="meta">
          <strong>From:</strong> \${escHtml(e.from)}<br/>
          <strong>To:</strong> \${escHtml((e.to||[]).join(', '))}<br/>
          <strong>Subject:</strong> \${escHtml(e.subject)}<br/>
          <strong>Date:</strong> \${new Date(e.receivedAt).toLocaleString()}<br/>
          <strong>Forwarded:</strong> \${e.forwarded ? '<span class="badge badge-fwd">Yes ✅</span>' : '<span class="badge badge-skip">No</span>'}<br/>
          <strong>Email ID:</strong> <code style="font-size:0.75rem">\${escHtml(e.id||'')}</code>
        </div>
        \${e.html
          ? \`<iframe id="preview-frame" srcdoc="\${escHtml(e.html)}" sandbox="allow-same-origin"></iframe>\`
          : e.text
            ? \`<pre style="white-space:pre-wrap;font-size:0.85rem;color:#333">\${escHtml(e.text)}</pre>\`
            : \`<div style="padding:16px;color:#999;font-size:0.85rem">
                (no content — body not provided by Resend for this email)<br/><br/>
                <a href="https://resend.com/inbound" target="_blank" rel="noopener">View in Resend dashboard →</a>
               </div>\`
        }
      \`;
    }
  </script>
</body>
</html>`);
});

// ─── API: list emails (JSON) ─────────────────────────────────────────────────
app.get('/api/emails', (req, res) => {
  res.json(receivedEmails.map(({ html, ...rest }) => rest)); // omit html from list
});

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Email test endpoint ──────────────────────────────────────────────────────
app.get('/test-email', async (req, res) => {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const SMTP_USER = process.env.SMTP_USER;
  const REVOLUT_EMAIL = process.env.REVOLUT_EMAIL;

  if (!BREVO_API_KEY || !SMTP_USER) {
    return res.status(500).json({ error: 'BREVO_API_KEY or SMTP_USER not set' });
  }

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: SMTP_USER },
        to: [{ email: SMTP_USER }], // send test to self
        subject: 'Receipt Forwarder — test',
        textContent: 'Brevo outbound is working.',
      }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(body));
    res.json({ ok: true, from: SMTP_USER, revolut_email: REVOLUT_EMAIL || '(not set)', brevo: body });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Receipt Forwarder running on port ${PORT}`);
  console.log(`   SMTP_USER:      ${process.env.SMTP_USER || '(not set)'}`);
  console.log(`   REVOLUT_EMAIL:  ${process.env.REVOLUT_EMAIL || '(not set)'}`);
  console.log(`   SMTP_PASS:      ${process.env.SMTP_PASS ? '(set)' : '(not set)'}`);
});
