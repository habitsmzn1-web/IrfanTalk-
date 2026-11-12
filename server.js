
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require("firebase-admin");
const path = require('path');
const crypto = require('crypto');

const app = express();
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://irfantalk-default-rtdb.firebaseio.com"
});

const db = admin.database();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Temporary OTP storage (cleared when server restarts)
const otpStore = new Map();
const lastSent = new Map();

const hash = value =>
  crypto.createHash('sha256').update(value).digest('hex');

// Send signup OTP
app.post('/api/otp/send', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required.' });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ error: 'Email service is not configured.' });
    }

    const now = Date.now();
    if (lastSent.has(email) && now - lastSent.get(email) < 60 * 1000) {
      return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });
    }

    const code = String(crypto.randomInt(100000, 1000000));

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'IrfanTalk <onboarding@resend.dev>',
        to: [email],
        subject: 'Your IrfanTalk verification code',
        html: `<div style="font-family:Arial">
          <h2>Welcome to IrfanTalk</h2>
          <p>Your signup verification code is:</p>
          <h1 style="letter-spacing:8px">${code}</h1>
          <p>This code expires in 5 minutes. Do not share it.</p>
        </div>`
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(502).json({
        error: 'Email could not be sent. Check Resend test-mode recipient verification.'
      });
    }

    otpStore.set(email, {
      codeHash: hash(code),
      expires: now + 5 * 60 * 1000,
      attempts: 0
    });
    lastSent.set(email, now);

    res.json({ success: true, message: 'Verification code sent.' });
  } catch (error) {
    console.error('OTP send error:', error);
    res.status(500).json({ error: 'Could not send verification code.' });
  }
});

// Verify signup OTP
app.post('/api/otp/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const record = otpStore.get(email);

  if (!record) {
    return res.status(400).json({ error: 'Request a new verification code.' });
  }

  if (Date.now() > record.expires) {
    otpStore.delete(email);
    return res.status(400).json({ error: 'Code expired. Request a new one.' });
  }

  record.attempts++;

  if (record.attempts > 5) {
    otpStore.delete(email);
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }

  if (!/^\d{6}$/.test(code) || hash(code) !== record.codeHash) {
    return res.status(400).json({ error: 'Incorrect verification code.' });
  }

  otpStore.delete(email);

const expiresAt = Date.now() + 10 * 60 * 1000;

const payload = Buffer.from(
  JSON.stringify({ email, expiresAt })
).toString('base64url');

const signature = crypto
  .createHmac('sha256', process.env.OTP_VERIFICATION_SECRET)
  .update(payload)
  .digest('hex');

const verificationToken = `${payload}.${signature}`;

res.json({
  success: true,
  verified: true,
  verificationToken
});
});
app.post('/api/signup', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const token = String(req.body.verificationToken || '');

    if (!email || !password || !name || !token) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return res.status(401).json({ error: 'Invalid verification token.' });
    }

    const [payload, signature] = parts;

    const expected = crypto
      .createHmac('sha256', process.env.OTP_VERIFICATION_SECRET)
      .update(payload)
      .digest('hex');

    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid verification token.' });
    }

    const verified = JSON.parse(
      Buffer.from(payload, 'base64url').toString()
    );

    if (
      verified.email !== email ||
      Date.now() > verified.expiresAt
    ) {
      return res.status(401).json({ error: 'Verification expired. Verify again.' });
    }

    const user = await admin.auth().createUser({
      email,
      password,
      displayName: name,
      emailVerified: true
    });

    await db.ref('userDirectory/' + user.uid).set({
      name,
      username: email.split('@')[0],
      updatedAt: Date.now()
    });

    res.json({ success: true, uid: user.uid });

  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(400).json({ error: 'Account creation failed.' });
  }
});
// Voice signaling
io.on('connection', socket => {
  socket.emit('connected', { socketId: socket.id });

  socket.on('join-voice-room', roomId => {
    if (!roomId || typeof roomId !== 'string') return;
    socket.join(roomId);

    const room = io.sockets.adapter.rooms.get(roomId);
    const peers = room
      ? [...room].filter(id => id !== socket.id)
      : [];

    socket.emit('voice-room-users', peers);
    socket.to(roomId).emit('voice-user-joined', {
      userId: socket.id
    });
  });

  socket.on('voice-offer', ({ target, offer } = {}) => {
    if (target) io.to(target).emit('voice-offer', {
      from: socket.id, offer
    });
  });

  socket.on('voice-answer', ({ target, answer } = {}) => {
    if (target) io.to(target).emit('voice-answer', {
      from: socket.id, answer
    });
  });

  socket.on('voice-ice-candidate', ({ target, candidate } = {}) => {
    if (target) io.to(target).emit('voice-ice-candidate', {
      from: socket.id, candidate
    });
  });

  socket.on('disconnect', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit('voice-user-left', {
          userId: socket.id
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`IrfanTalk server running on port ${PORT}`);
});
