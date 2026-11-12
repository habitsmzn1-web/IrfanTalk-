
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
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
  res.json({ success: true, verified: true });
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
