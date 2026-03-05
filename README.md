# Receipt Forwarder

Automatically forwards receipts and invoices from your Gmail inbox to your Revolut email. Built with [Resend](https://resend.com) for inbound email and Railway for hosting.

## How it works

```
Gmail → (filter) → Resend inbound address → webhook → this app → Revolut email
```

1. Gmail filter matches receipts/invoices and forwards to your Resend inbound address
2. Resend receives the email and POSTs a webhook to this app
3. The app checks if the email looks like a receipt/invoice (keyword matching)
4. If yes, it forwards to your Revolut email via Resend
5. A simple inbox UI lets you view all received emails

The inbox UI is also how you get the Gmail verification link — when Gmail tries to verify the forwarding address, that email appears in the UI so you can click the link.

---

## Setup

### 1. Resend account

1. Sign up at [resend.com](https://resend.com)
2. Go to **API Keys** → create a key with full access
3. Go to **Emails → Receiving** → note your inbound address (e.g. `anything@abc123.resend.app`)

### 2. Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

1. Push this repo to GitHub
2. Create a new Railway project from the repo
3. Set these environment variables in Railway:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend API key |
| `REVOLUT_EMAIL` | Your Revolut receipts email |
| `FROM_EMAIL` | A verified Resend sender (or `onboarding@resend.dev` for testing) |

4. Railway will give you a public URL like `https://receipt-forwarder-production.up.railway.app`

### 3. Set up Resend webhook

1. In Resend, go to **Webhooks** → **Add Webhook**
2. URL: `https://your-railway-url.up.railway.app/webhook`
3. Select event: `email.received`
4. Save

### 4. Set up Gmail filter + forwarding

Since you can't verify a Revolut address directly, you forward to your Resend inbound address instead:

1. In Gmail: **Settings → See all settings → Forwarding and POP/IMAP**
2. Click **Add a forwarding address**
3. Enter your Resend inbound address (e.g. `receipts@abc123.resend.app`)
4. Gmail will send a verification email to that address
5. Open your app's inbox UI (`https://your-railway-url.up.railway.app`) — the verification email will appear there
6. Click the verification link in the email
7. Back in Gmail, confirm the forwarding address is verified

Then create the Gmail filter:
1. **Settings → Filters and Blocked Addresses → Create a new filter**
2. In the search box use:
   ```
   subject:(receipt OR invoice OR "order confirmation" OR "payment confirmation" OR "order #")
   ```
3. Click **Create filter**, then select **Forward it to** your Resend inbound address
4. Save

---

## Receipt detection keywords

The app forwards emails whose subject or body contains any of:

- receipt, invoice, order confirmation, payment confirmation
- your order, order #, order number, purchase confirmation
- payment receipt, transaction, billing, statement
- refund, subscription, renewal

Edit the `RECEIPT_KEYWORDS` array in `index.js` to add/remove keywords.

---

## Local development

```bash
npm install
cp .env.example .env
# Fill in your .env values
npm run dev
```

Use [ngrok](https://ngrok.com) to expose localhost for webhook testing:
```bash
ngrok http 3000
# Use the ngrok URL as your Resend webhook endpoint
```
