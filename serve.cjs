const http   = require('http')
const https  = require('https')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const DIR  = __dirname
const mime = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'
}

// ── Credentials ───────────────────────────────────────────────
// Get your Paystack secret key from: dashboard.paystack.com → Settings → API Keys
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET   || 'sk_live_01d14c6a632b5cf1a66e0d62ca53b6ef18145076'

// Telegram: create bot at t.me/BotFather → /newbot → copy token
// Get your chat ID: message your bot once, then open:
//   https://api.telegram.org/bot<TOKEN>/getUpdates  → look for "id" in "chat"
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8325911196:AAEfOqdFav-3FSZKumr1EsF0irjJ2ouQokc'
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '6780870656'

// Anthropic API key: console.anthropic.com → API Keys
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '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'

// Supabase — Genesis360Vest (participants/cycles)
const SUPABASE_URL          = 'https://tsnkgwmzokymokurkxjh.supabase.co'
const SUPABASE_SERVICE_ROLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzbmtnd216b2t5bW9rdXJreGpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTEyNzk0NCwiZXhwIjoyMDkwNzAzOTQ0fQ.ACo8ILY9hM04R0Uutqxv4kgXHx-CSvoKPUKtge7zGz8'
// Supabase — Genesis360Finance (loan ecosystem data for investor intelligence)
const GF_SUPABASE_URL     = 'https://tsnkgwmzokymokurkxjh.supabase.co'
const GF_SUPABASE_SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzbmtnd216b2t5bW9rdXJreGpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTEyNzk0NCwiZXhwIjoyMDkwNzAzOTQ0fQ.ACo8ILY9hM04R0Uutqxv4kgXHx-CSvoKPUKtge7zGz8'
const RESEND_API_KEY        = 're_NXDU3NRM_moBCWDH48nB6NiUkhKZpjjEo'

// ── In-memory OTP store for registration ─────────────────────
const _regOtpStore = new Map() // email → { otp, expires, attempts }

// ── Read raw POST body (string — needed for webhook sig) ──────
function readRawBody(req, cb) {
  let body = ''
  req.on('data', d => body += d)
  req.on('end', () => cb(null, body))
}

// ── Read POST body ────────────────────────────────────────────
function readBody(req, cb) {
  let body = ''
  req.on('data', d => body += d)
  req.on('end', () => {
    try { cb(null, JSON.parse(body || '{}')) }
    catch(e) { cb(e) }
  })
}

// ── Supabase REST helper ──────────────────────────────────────
function supabaseReq(method, table, query, body, cb) {
  const bodyStr = body ? JSON.stringify(body) : null
  const apiPath = '/rest/v1/' + table + (query ? '?' + query : '')
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE,
    'apikey':        SUPABASE_SERVICE_ROLE,
    'Prefer':        'return=representation'
  }
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr)
  const options = { hostname: new URL(SUPABASE_URL).hostname, path: apiPath, method, headers }
  const req = https.request(options, res => {
    let data = ''
    res.on('data', d => data += d)
    res.on('end', () => { try { cb(null, JSON.parse(data || 'null')) } catch(e) { cb(e) } })
  })
  req.on('error', cb)
  if (bodyStr) req.write(bodyStr)
  req.end()
}

// ── Paystack GET helper ───────────────────────────────────────
function paystackGet(apiPath, cb) {
  const options = {
    hostname: 'api.paystack.co',
    path:     apiPath,
    method:   'GET',
    headers:  { Authorization: 'Bearer ' + PAYSTACK_SECRET }
  }
  const req = https.request(options, res => {
    let data = ''
    res.on('data', d => data += d)
    res.on('end', () => { try { cb(null, JSON.parse(data)) } catch(e) { cb(e) } })
  })
  req.on('error', cb)
  req.end()
}

// ── Telegram helper ───────────────────────────────────────────
function telegramSend(text, cb) {
  if (TELEGRAM_BOT_TOKEN.includes('REPLACE')) { if (cb) cb(null); return }
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  const options = {
    hostname: 'api.telegram.org',
    path:     '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }
  const req = https.request(options, res => {
    res.on('data', () => {})
    res.on('end', () => { if (cb) cb(null) })
  })
  req.on('error', e => { console.error('Telegram error:', e.message); if (cb) cb(e) })
  req.write(body)
  req.end()
}

// ── Resend email helper ───────────────────────────────────────
function sendEmail(to, subject, html, cb) {
  const body = JSON.stringify({ from: 'Genesis360 <noreply@genesis360vest.com>', to: [to], subject, html })
  const options = {
    hostname: 'api.resend.com',
    path:     '/emails',
    method:   'POST',
    headers:  { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }
  const req = https.request(options, res => {
    let data = ''
    res.on('data', d => data += d)
    res.on('end', () => {
      try {
        const result = JSON.parse(data)
        console.log('Resend response:', res.statusCode, JSON.stringify(result))
        if (res.statusCode >= 400) { cb(new Error(result.message || 'Resend error ' + res.statusCode)) } else { cb(null, result) }
      } catch(e) { cb(e) }
    })
  })
  req.on('error', e => { console.error('Resend error:', e.message); if (cb) cb(e) })
  req.write(body)
  req.end()
}

// ── Anthropic (Claude) helper ─────────────────────────────────
function claudePost(messages, systemPrompt, cb) {
  if (ANTHROPIC_API_KEY.includes('REPLACE')) {
    cb(null, { error: 'Anthropic API key not configured' }); return
  }
  const body = JSON.stringify({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
    system:     systemPrompt,
    messages
  })
  const options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers:  {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(body)
    }
  }
  const req = https.request(options, res => {
    let data = ''
    res.on('data', d => data += d)
    res.on('end', () => { try { cb(null, JSON.parse(data)) } catch(e) { cb(e) } })
  })
  req.on('error', cb)
  req.write(body)
  req.end()
}

// ── API handler ───────────────────────────────────────────────
function handleAPI(req, url, rawUrl, res) {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  }

  // ── GET /api/banks ────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/banks') {
    paystackGet('/bank?currency=NGN&perPage=200', (err, data) => {
      if (err) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Failed to fetch banks' })); return }
      res.writeHead(200, cors)
      res.end(JSON.stringify(data))
    })
    return true
  }

  // ── GET /api/verify-account?account_number=&bank_code= ───
  if (req.method === 'GET' && url === '/api/verify-account') {
    const qs     = rawUrl.includes('?') ? rawUrl.split('?')[1] : ''
    const params = Object.fromEntries(new URLSearchParams(qs))
    const { account_number, bank_code } = params
    if (!account_number || !bank_code) {
      res.writeHead(400, cors)
      res.end(JSON.stringify({ status: false, message: 'account_number and bank_code required' }))
      return true
    }
    paystackGet(`/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`, (err, data) => {
      if (err) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Verification failed' })); return }
      res.writeHead(200, cors)
      res.end(JSON.stringify(data))
    })
    return true
  }

  // ── POST /api/register/send-otp  — generate & email 6-digit OTP ──
  if (req.method === 'POST' && url === '/api/register/send-otp') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Bad request' })); return }
      const { email, name } = body
      if (!email) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Email required' })); return }
      const otp = String(Math.floor(100000 + Math.random() * 900000))
      const expires = Date.now() + 10 * 60 * 1000 // 10 min
      _regOtpStore.set(email.toLowerCase(), { otp, expires, attempts: 0 })
      const firstName = (name || 'there').split(' ')[0]
      const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
        <div style="background:#0F3D2E;padding:28px 32px;text-align:center">
          <h1 style="color:#ffffff;font-size:22px;font-weight:800;margin:0">Genesis<span style="color:#C7FF4A">360</span></h1>
          <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:4px 0 0">Investor Platform</p>
        </div>
        <div style="padding:36px 32px;text-align:center">
          <h2 style="color:#0a2218;font-size:20px;font-weight:700;margin:0 0 8px">Verify your email</h2>
          <p style="color:#6b7280;font-size:14px;margin:0 0 28px">Hi ${firstName}, use the code below to verify your Genesis360 account.</p>
          <div style="background:#f3f4f6;border-radius:12px;padding:24px;margin:0 auto 24px;max-width:240px">
            <div style="font-size:40px;font-weight:900;letter-spacing:12px;color:#0F3D2E;line-height:1">${otp}</div>
            <p style="color:#9ca3af;font-size:11px;margin:10px 0 0;text-transform:uppercase;letter-spacing:.06em">Expires in 10 minutes</p>
          </div>
          <p style="color:#9ca3af;font-size:12px">If you did not create this account, ignore this email.</p>
        </div>
        <div style="background:#f9fafb;padding:18px 32px;text-align:center;border-top:1px solid #f0f0f0">
          <p style="color:#9ca3af;font-size:11px;margin:0">&copy; 2026 Genesis360. Nigeria.</p>
        </div>
      </div>`
      sendEmail(email, 'Genesis360 — Your verification code', html, (sendErr) => {
        if (sendErr) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Failed to send OTP email' })); return }
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }))
      })
    })
    return true
  }

  // ── POST /api/register/verify-otp  — validate OTP ──────────────
  if (req.method === 'POST' && url === '/api/register/verify-otp') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Bad request' })); return }
      const { email, otp, userId } = body
      if (!email || !otp) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Missing fields' })); return }
      const key = email.toLowerCase()
      const record = _regOtpStore.get(key)
      if (!record) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'No OTP found. Please resend.' })); return }
      if (Date.now() > record.expires) {
        _regOtpStore.delete(key)
        res.writeHead(400, cors); res.end(JSON.stringify({ error: 'OTP expired. Please request a new one.' })); return
      }
      record.attempts = (record.attempts || 0) + 1
      if (record.attempts > 5) {
        _regOtpStore.delete(key)
        res.writeHead(429, cors); res.end(JSON.stringify({ error: 'Too many attempts. Please register again.' })); return
      }
      if (otp.trim() !== record.otp) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Incorrect code. Please try again.' })); return
      }
      _regOtpStore.delete(key)

      // Confirm user email in Supabase so signInWithPassword works
      if (userId) {
        const confirmBody = JSON.stringify({ email_confirm: true })
        const opts = {
          hostname: new URL(SUPABASE_URL).hostname,
          path: `/auth/v1/admin/users/${userId}`,
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE,
            'apikey': SUPABASE_SERVICE_ROLE,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(confirmBody)
          }
        }
        const confirmReq = https.request(opts, r => { r.resume() })
        confirmReq.on('error', () => {})
        confirmReq.write(confirmBody)
        confirmReq.end()
      }

      res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }))
    })
    return true
  }

  // ── POST /api/send-confirmation  — send welcome email via Resend ──
  if (req.method === 'POST' && url === '/api/send-confirmation') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Bad request' })); return }
      const { email, name } = body
      if (!email) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Email required' })); return }
      const firstName = (name || 'there').split(' ')[0]
      const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0"><div style="background:#0f172a;padding:28px 32px;text-align:center"><h1 style="color:#ffffff;font-size:22px;font-weight:800;margin:0">Genesis<span style="color:#9DC43A">360</span></h1><p style="color:rgba(255,255,255,0.5);font-size:12px;margin:4px 0 0">Diaspora Funding Cycles</p></div><div style="padding:36px 32px"><h2 style="color:#0f172a;font-size:20px;font-weight:700;margin:0 0 12px">Welcome, ${firstName}!</h2><p style="color:#64748b;font-size:15px;line-height:1.6;margin:0 0 20px">Your Genesis360 account has been created. Complete your setup by creating a transaction PIN to secure your account.</p><a href="https://global-genesis360.com/setup-pin" style="display:inline-block;background:#1E4535;color:#ffffff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none">Set Up My PIN &rarr;</a><p style="color:#94a3b8;font-size:12px;margin:24px 0 0">If you did not create this account, please ignore this email.</p></div><div style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0"><p style="color:#94a3b8;font-size:12px;margin:0">&copy; 2026 Genesis360. Abeokuta, Ogun State, Nigeria.</p></div></div>`
      sendEmail(email, 'Welcome to Genesis360 — Complete Your Setup', html, (sendErr, result) => {
        if (sendErr) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Failed to send email' })); return }
        res.writeHead(200, cors)
        res.end(JSON.stringify({ ok: true, id: result && result.id }))
      })
    })
    return true
  }

  // ── POST /api/notify  — send Telegram alert ───────────────
  if (req.method === 'POST' && url === '/api/notify') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Bad request' })); return }
      telegramSend(body.text || '(empty)', () => {
        res.writeHead(200, cors)
        res.end(JSON.stringify({ ok: true }))
      })
    })
    return true
  }

  // ── POST /api/risk-score  — Claude AI risk scoring ────────
  if (req.method === 'POST' && url === '/api/risk-score') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Bad request' })); return }
      const { full_name, country, kyc_status, wallet_balance, total_deposited, cycles_joined } = body

      const systemPrompt = `You are a risk assessment engine for Genesis360, a diaspora funding platform where participants fund cycles supporting African food businesses.
Evaluate the participant data and return a JSON object with exactly these fields:
- score: integer 0-100 (100 = lowest risk / most trusted)
- tier: "standard" | "priority" | "restricted"
- summary: one concise sentence explaining the score
- flags: array of short risk flag strings (empty array if none)

Scoring guide:
- KYC approved: +40 base; KYC pending: +20 base; KYC rejected: 0, tier must be "restricted"
- wallet_balance >= 500: +15; >= 100: +8
- total_deposited >= 1000: +15; >= 300: +8; >= 100: +4
- cycles_joined >= 3: +15; >= 1: +8
- Tier "priority" requires score >= 75 and KYC approved
- Tier "restricted" if KYC rejected OR score < 30
- Otherwise tier "standard"
Return ONLY valid JSON. No markdown, no explanation outside the JSON.`

      const userMsg = `Name: ${full_name || 'Unknown'}
Country: ${country || 'Unknown'}
KYC Status: ${kyc_status || 'pending'}
Wallet Balance: $${wallet_balance || 0}
Total Deposited: $${total_deposited || 0}
Cycles Joined: ${cycles_joined || 0}`

      claudePost([{ role: 'user', content: userMsg }], systemPrompt, (err, data) => {
        if (err) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'AI scoring failed' })); return }
        if (data.error) { res.writeHead(500, cors); res.end(JSON.stringify({ error: data.error })); return }
        try {
          const raw    = data.content[0].text.trim()
          const result = JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{')))
          res.writeHead(200, cors)
          res.end(JSON.stringify(result))
        } catch(e) {
          res.writeHead(500, cors)
          res.end(JSON.stringify({ error: 'Failed to parse AI response', raw: data?.content?.[0]?.text }))
        }
      })
    })
    return true
  }

  // ── POST /api/kyc/send-otp ────────────────────────────────────
  if (req.method === 'POST' && url === '/api/kyc/send-otp') {
    readBody(req, (err, body) => {
      const { user_id, email, full_name, phone, nin_bvn, address } = body
      if (!user_id || !email) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Missing fields' })); return
      }
      const otp = String(Math.floor(100000 + Math.random() * 900000))
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      // Store OTP + details in profiles
      supabaseReq('PATCH', 'profiles', 'id=eq.' + user_id, {
        full_name, phone, nin_bvn, address,
        kyc_otp: otp, kyc_otp_expires: expires, kyc_status: 'pending'
      }, (err2) => {
        if (err2) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'DB error' })); return }
        const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
          <div style="background:#0e2114;padding:32px 28px;text-align:center">
            <div style="font-size:22px;font-weight:900;color:#fff">Genesis<span style="color:#A6D64A">360</span></div>
          </div>
          <div style="padding:32px 28px">
            <h2 style="font-size:18px;color:#0e2114;margin-bottom:8px">Verify Your Identity</h2>
            <p style="color:#5a7a66;font-size:14px;margin-bottom:24px">Hi ${full_name || 'there'}, use this OTP to complete your identity verification before withdrawing.</p>
            <div style="background:#f4f8f0;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
              <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#0e2114">${otp}</div>
              <div style="font-size:12px;color:#5a7a66;margin-top:8px">Expires in 10 minutes</div>
            </div>
            <p style="color:#5a7a66;font-size:13px">If you did not request this, ignore this email.</p>
          </div>
        </div>`
        sendEmail(email, 'Genesis360 — Identity Verification OTP', html, (sendErr) => {
          if (sendErr) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Email failed' })); return }
          res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }))
        })
      })
    })
    return true
  }

  // ── POST /api/kyc/verify-otp ──────────────────────────────────
  if (req.method === 'POST' && url === '/api/kyc/verify-otp') {
    readBody(req, (err, body) => {
      const { user_id, otp } = body
      if (!user_id || !otp) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Missing fields' })); return
      }
      supabaseReq('GET', 'profiles', 'id=eq.' + user_id, null, (err2, rows) => {
        if (err2 || !rows || rows.length === 0) {
          res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Profile not found' })); return
        }
        const profile = rows[0]
        if (profile.kyc_otp !== otp) {
          res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Invalid OTP' })); return
        }
        if (new Date(profile.kyc_otp_expires) < new Date()) {
          res.writeHead(400, cors); res.end(JSON.stringify({ error: 'OTP expired' })); return
        }
        supabaseReq('PATCH', 'profiles', 'id=eq.' + user_id, {
          kyc_status: 'approved', kyc_otp: null, kyc_otp_expires: null
        }, (err3) => {
          if (err3) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'DB error' })); return }
          res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }))
        })
      })
    })
    return true
  }

  // ── POST /api/v1/paystack/webhook ────────────────────────────
  if (req.method === 'POST' && url === '/api/v1/paystack/webhook') {
    readRawBody(req, (err, rawBody) => {
      // Verify Paystack signature
      const sig  = req.headers['x-paystack-signature'] || ''
      const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(rawBody).digest('hex')
      if (sig !== hash) {
        console.log('Webhook: invalid signature — rejected')
        res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Invalid signature' })); return
      }

      let event
      try { event = JSON.parse(rawBody) } catch(e) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Bad JSON' })); return
      }

      // Always respond 200 immediately so Paystack doesn't retry
      res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }))

      if (event.event !== 'charge.success') return

      const data     = event.data || {}
      const meta     = data.metadata || {}
      const userId   = meta.user_id
      const usdEquiv = parseFloat(meta.usd_equiv || 0)
      const ref      = data.reference || ''
      const currency = data.currency  || 'NGN'
      const gateway  = currency === 'NGN' ? 'Paystack NGN' : 'Paystack International'

      if (!userId || !(usdEquiv > 0)) {
        console.log('Webhook: missing user_id or usd_equiv in metadata', meta); return
      }

      // Fetch current wallet balance
      supabaseReq('GET', 'wallets', 'user_id=eq.' + userId, null, (err, rows) => {
        if (err || !rows || rows.length === 0) {
          console.error('Webhook: wallet not found for', userId, err); return
        }
        const wallet = rows[0]
        const newBal = parseFloat(((wallet.balance_usd || 0) + usdEquiv).toFixed(2))
        const newDep = parseFloat(((wallet.total_deposited || 0) + usdEquiv).toFixed(2))

        // Update wallet balance
        supabaseReq('PATCH', 'wallets', 'user_id=eq.' + userId,
          { balance_usd: newBal, total_deposited: newDep },
          (err) => {
            if (err) { console.error('Webhook: wallet update failed', err); return }

            // Record transaction
            supabaseReq('POST', 'transactions', '', {
              user_id: userId, type: 'deposit', amount: usdEquiv,
              status: 'completed', description: 'Deposit via ' + gateway,
              reference: ref, created_at: new Date().toISOString()
            }, () => {})

            // Push notification to user
            supabaseReq('POST', 'notifications', '', {
              user_id: userId, title: 'Deposit Confirmed',
              message: `Your deposit of $${usdEquiv.toFixed(2)} USD has been confirmed.`,
              type: 'success', read: false, created_at: new Date().toISOString()
            }, () => {})

            // Telegram alert to CEO
            telegramSend(`✅ <b>Payment Confirmed</b>\nUser ID: <code>${userId}</code>\nAmount: <b>$${usdEquiv.toFixed(2)} USD</b>\nGateway: ${gateway}\nRef: ${ref}`)
            console.log(`Webhook: ✅ credited $${usdEquiv} to user ${userId} (${ref})`)
          }
        )
      })
    })
    return true
  }

  // ── GET /api/investor/ecosystem ──────────────────────────────
  if (req.method === 'GET' && url === '/api/investor/ecosystem') {
    gfEcosystem().then(data => {
      res.writeHead(200, cors)
      res.end(JSON.stringify({ ok: true, as_of: new Date().toISOString(), ecosystem: data }))
    }).catch(e => {
      res.writeHead(500, cors)
      res.end(JSON.stringify({ ok: false, error: e.message }))
    })
    return true
  }

  return false
}

// ── Genesis360Finance ecosystem metrics ──────────────────────
function gfGet(path) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'tsnkgwmzokymokurkxjh.supabase.co',
      path: path,
      method: 'GET',
      headers: {
        'apikey': GF_SUPABASE_SERVICE,
        'Authorization': 'Bearer ' + GF_SUPABASE_SERVICE,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': 'return=representation'
      }
    }
    const r = https.request(opts, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve([]) } })
    })
    r.on('error', () => resolve([]))
    r.setTimeout(10000, () => { r.destroy(); resolve([]) })
    r.end()
  })
}

async function gfEcosystem() {
  const [loans, reps, supps, users, txs] = await Promise.all([
    gfGet('/rest/v1/gf_loans?select=id,status,amount_approved,amount_requested,created_at'),
    gfGet('/rest/v1/gf_repayments?select=status,amount'),
    gfGet('/rest/v1/gf_suppliers?verified=eq.true&select=id'),
    gfGet('/rest/v1/gf_users?select=id,credit_score,risk_tier,city,created_at'),
    gfGet('/rest/v1/gf_wallet_transactions?select=amount,transaction_type,created_at')
  ])
  const la = Array.isArray(loans) ? loans : []
  const ra = Array.isArray(reps)  ? reps  : []
  const sa = Array.isArray(supps) ? supps : []
  const ua = Array.isArray(users) ? users : []
  const ta = Array.isArray(txs)   ? txs   : []

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const totalCapital    = la.filter(l=>!['pending','rejected'].includes(l.status)).reduce((s,l)=>s+(l.amount_approved||l.amount_requested||0),0)
  const activeLoans     = la.filter(l=>['active','disbursed'].includes(l.status))
  const activeLoanVal   = activeLoans.reduce((s,l)=>s+(l.amount_approved||l.amount_requested||0),0)
  const avgLoanSize     = la.length>0 ? Math.round(totalCapital/la.length) : 0
  const approvedApps    = la.filter(l=>!['pending','rejected'].includes(l.status)).length
  const approvalRate    = la.length>0 ? Math.round(approvedApps/la.length*100) : 0
  const paidReps        = ra.filter(r=>r.status==='paid').length
  const totalReps       = ra.length
  const repRate         = totalReps>0 ? parseFloat((paidReps/totalReps*100).toFixed(1)) : 0
  const defaultedReps   = ra.filter(r=>r.status==='defaulted').length
  const defaultRate     = totalReps>0 ? parseFloat((defaultedReps/totalReps*100).toFixed(1)) : 0
  const lateReps        = ra.filter(r=>r.status==='overdue').length
  const lateRate        = totalReps>0 ? parseFloat((lateReps/totalReps*100).toFixed(1)) : 0
  const newThisMonth    = ua.filter(u=>new Date(u.created_at)>=monthStart).length
  const cities          = [...new Set(ua.map(u=>u.city).filter(Boolean))].length
  const supplierTxs     = ta.filter(t=>t.transaction_type==='supplier_payment')
  const supplierRatio   = ta.length>0 ? Math.round(supplierTxs.length/ta.length*100) : 82
  const scores          = ua.map(u=>u.credit_score||0).filter(s=>s>0)
  const avgScore        = scores.length>0 ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0
  const tiers           = ua.reduce((acc,u)=>{ const t=u.risk_tier||'moderate'; acc[t]=(acc[t]||0)+1; return acc },{})
  const total           = ua.length||1
  return {
    restaurants_onboarded:    ua.length,
    new_restaurants_this_month: newThisMonth,
    active_suppliers:         sa.length,
    cities_covered:           cities,
    total_loans_issued:       la.length,
    total_capital_deployed:   totalCapital,
    avg_loan_size:            avgLoanSize,
    active_loan_portfolio:    activeLoanVal,
    repayment_rate:           repRate,
    default_rate:             defaultRate,
    late_payment_ratio:       lateRate,
    avg_credit_score:         avgScore,
    approval_rate:            approvalRate,
    supplier_payment_ratio:   supplierRatio,
    _tier_distribution: {
      elite:     Math.round((tiers.elite||0)/total*100),
      strong:    Math.round((tiers.strong||0)/total*100),
      moderate:  Math.round((tiers.moderate||0)/total*100),
      weak:      Math.round((tiers.weak||0)/total*100),
      very_risky:Math.round((tiers.very_risky||0)/total*100)
    }
  }
}

// ── Static file server ────────────────────────────────────────
function serve(port, routes) {
  http.createServer((req, res) => {
    const rawUrl = req.url
    let url = rawUrl.split('?')[0].split('#')[0]
    if (url !== '/' && url.endsWith('/')) url = url.slice(0, -1)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET,POST',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end(); return
    }

    // API routes
    if (url.startsWith('/api/') && handleAPI(req, url, rawUrl, res)) return

    const mapped   = routes[url]
    const filePath = mapped
      ? path.resolve(DIR, mapped)
      : path.resolve(DIR, url.slice(1))

    fs.readFile(filePath, (err, data) => {
      if (err) {
        console.log(`[${port}] 404 → ${url}`)
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found'); return
      }
      const ext     = path.extname(filePath)
      const type    = mime[ext] || 'text/plain'
      const headers = { 'Content-Type': type }
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
        headers['Pragma']        = 'no-cache'
      }
      res.writeHead(200, headers)
      res.end(data)
    })
  }).listen(port)
}

// ── Servers ───────────────────────────────────────────────────
// SERVICE env var controls which server starts on Render:
//   SERVICE=user  → user app  (default locally: port 3000)
//   SERVICE=admin → admin app (default locally: port 3001)
// Render sets PORT automatically; locally defaults are used.

const SERVICE = (process.env.SERVICE || 'both').toLowerCase()
const PORT    = parseInt(process.env.PORT || '0')

const USER_ROUTES = {
  '/':           'preview.html',
  '/preview':    'preview.html',
  '/register':   'register.html',
  '/login':      'login.html',
  '/setup-pin':  'setup-pin.html',
  '/dashboard':  'dashboard.html',
  '/about':               'about.html',
  '/investor-intelligence':'investor-intelligence.html',
}

const ADMIN_ROUTES = {
  '/': 'admin.html',
  '/investor-intelligence': 'investor-intelligence.html',
}

if (SERVICE === 'admin') {
  serve(PORT || 3001, ADMIN_ROUTES)
} else if (SERVICE === 'user') {
  serve(PORT || 3000, USER_ROUTES)
} else {
  // Local dev: run both
  serve(PORT || 3000, USER_ROUTES)
  serve(3001, ADMIN_ROUTES)
}

// ── Startup log ───────────────────────────────────────────────
console.log('\n  Genesis360 — Server Running')
console.log('  ─────────────────────────────')
if (SERVICE === 'admin')      console.log('  Admin     →  http://localhost:' + (PORT || 3001))
else if (SERVICE === 'user')  console.log('  User App  →  http://localhost:' + (PORT || 3000))
else {
  console.log('  User App  →  http://localhost:' + (PORT || 3000))
  console.log('  Admin     →  http://localhost:3001')
}
console.log('  DIR       →  ' + DIR)
console.log('')
if (PAYSTACK_SECRET.includes('REPLACE'))   console.log('  ⚠️  PAYSTACK_SECRET  not set — bank verification disabled')
else                                        console.log('  ✅ Paystack configured')
if (TELEGRAM_BOT_TOKEN.includes('REPLACE')) console.log('  ⚠️  TELEGRAM_BOT_TOKEN not set — alerts disabled')
else                                        console.log('  ✅ Telegram configured  (chat ' + TELEGRAM_CHAT_ID + ')')
if (ANTHROPIC_API_KEY.includes('REPLACE'))  console.log('  ⚠️  ANTHROPIC_API_KEY  not set — AI scoring disabled')
else                                        console.log('  ✅ Claude AI configured')
console.log('')

// ── Vercel serverless export ──────────────────────────────────
if (require.main !== module) {
  module.exports = (req, res) => {
    const rawUrl = req.url || '/'
    let url = rawUrl.split('?')[0].split('#')[0]
    if (url !== '/' && url.endsWith('/')) url = url.slice(0, -1)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type' })
      res.end(); return
    }
    if (url.startsWith('/api/') && handleAPI(req, url, rawUrl, res)) return
    const mapped   = USER_ROUTES[url]
    const filePath = mapped ? path.resolve(DIR, mapped) : path.resolve(DIR, url.slice(1))
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found'); return }
      const ext     = path.extname(filePath)
      const type    = mime[ext] || 'text/plain'
      const headers = { 'Content-Type': type }
      if (ext === '.html') { headers['Cache-Control'] = 'no-store, no-cache, must-revalidate' }
      res.writeHead(200, headers)
      res.end(data)
    })
  }
}
