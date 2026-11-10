
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Connected users
const users = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.emit('connected', {
    socketId: socket.id
  });

  // Join a voice room
  socket.on('join-voice-room', (roomId) => {
    if (!roomId) return;

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

  // Send voice connection offer
  socket.on('voice-offer', ({ target, offer }) => {
    io.to(target).emit('voice-offer', {
      from: socket.id,
      offer
    });
  });

  // Send voice connection answer
  socket.on('voice-answer', ({ target, answer }) => {
    io.to(target).emit('voice-answer', {
      from: socket.id,
      answer
    });
  });

  // Send network connection information
  socket.on('voice-ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('voice-ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  // Existing real-time chat
  socket.on('chat message', (msg) => {
    io.emit('chat message', msg);
  });

  // Handle user disconnect
  socket.on('disconnect', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit('voice-user-left', {
          userId: socket.id
        });
      }
    }

    console.log('User disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
