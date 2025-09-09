import dotenv from 'dotenv';
// Load environment variables from .env file
dotenv.config();

// Ensure MONGODB_URI is set
if (!process.env.MONGODB_URI) {
  console.error('❌ Error: MONGODB_URI is not defined in environment');
  process.exit(1);
}

import mongoose from 'mongoose';
import dns from 'dns';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';

// Import routers & models
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import User from './models/User.js';
import adminRoutes from "./routes/admin.js";
import webhookRoutes from './routes/webhook.js';   // ← ES import
import userRoutes from "./routes/user.js";
import './models/WeeklyReport.js';
import coachRoutes from './routes/coach.js';
import forumRoutes from './routes/forum.js';
import houseRoutes from './routes/house.js';
import decisionHelperRoutes from './routes/decision-helper.js';
import messagesRoutes from './routes/messages.js';

// Prefer IPv4 to avoid potential DNS v6 issues
dns.setDefaultResultOrder('ipv4first');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
})
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
app.set('io', io); // Make io accessible in routes if needed

// Compute __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mount webhook routes at /webhook for Mux and Tally webhooks
app.use('/webhook', webhookRoutes);

// Express middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----- API ROUTES -----
// Authentication endpoints
app.use('/auth', authRoutes);
// User/profile for coaches endpoints
app.use('/api', profileRoutes);
//for general users
app.use('/api', userRoutes);
//tally form submission from coaches
app.use('/api', webhookRoutes);

// mount admin
app.use('/api/admin', adminRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/forum', forumRoutes);
app.use('/api/houses', houseRoutes);
app.use('/api/decision-helper', decisionHelperRoutes);
app.use('/api/messages', messagesRoutes);

// Form submission endpoint
app.post('/api/submit', async (req, res) => {
  try {
    console.log('🔥 API HIT – Full body:', req.body);
    const {
      discord_id,
      physical, mental, social, love, career, creative,
      travel, family, style, spiritual, additional,
      date_of_birth, gender, country,
      username, email,
      ...rest
    } = req.body;

    if (!discord_id && !email) return res.status(400).send('Missing discord_id or email');

    // Set username to email prefix if missing
    let finalUsername = username;
    if ((!finalUsername || finalUsername === 'undefined') && email) {
      finalUsername = email.split('@')[0];
    }

    // Age validation
    const birthDate = new Date(date_of_birth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    if (age < 13) return res.status(403).send('You must be at least 13');
    if (age > 100) return res.status(400).send('Enter a valid age under 100');

    // Extract channels
    const channels = Object.entries(rest)
      .filter(([key, value]) => key.startsWith('channel_') && value === 'on')
      .map(([key]) => key.replace('channel_', ''));

    // Upsert user profile
    const updatedUser = await User.findOneAndUpdate(
      { discord_id },
      {
        $set: {
          physical, mental, social, love, career, creative,
          travel, family, style, spiritual, additional,
          gender, country, date_of_birth: birthDate,
          identity_completed: true,
          channels,
          username: finalUsername,
        }
      },
      { new: true, upsert: true }
    );

    // Render success page
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Submission Successful</title>
        <style>
          body { font-family: sans-serif; background: #0f2027; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .container { text-align: center; }
          a { color: lightblue; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Submission Successful</h1>
          <p>Your profile has been updated.</p>
          <a href="https://discord.com">Return to Discord</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Error saving data:', err);
    return res.status(500).send('❌ Failed to save');
  }
});

// ----- STATIC ASSETS & SPA FALLBACK -----
const publicPath = path.join(__dirname, 'public');
// Serve static files (HTML, CSS, JS, images)
app.use(express.static(publicPath));

// Serve OneSignal service worker directly to avoid SPA fallback
app.get('/OneSignalSDKWorker.js', (req, res) => {
  res.sendFile(path.join(publicPath, 'OneSignalSDKWorker.js'));
});

// Catch-all for client-side routing (serve index.html for non-API GETs)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    // If no API route matched, return 404 JSON
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Socket.IO real-time chat logic
io.on('connection', (socket) => {
  // Join a house room
  socket.on('joinHouseRoom', (houseId) => {
    socket.join(`house_${houseId}`);
  });

  // Handle new chat message (expects { houseId, message, user })
  socket.on('houseMessage', (data) => {
    const { houseId, message, user } = data;
    // Broadcast to all in the house room (including sender)
    io.to(`house_${houseId}`).emit('houseMessage', { houseId, message, user, createdAt: new Date() });
  });

  // Optionally handle disconnects, etc.
  // DM rooms for user↔coach threads
  socket.on('joinDmRoom', ({ userId, coachId }) => {
    if (!userId || !coachId) return;
    socket.join(`dm_${userId}_${coachId}`);
  });
  socket.on('dmMessage', (data) => {
    const { userId, coachId, message, senderType, at } = data || {};
    if (!userId || !coachId || !message) return;
    io.to(`dm_${userId}_${coachId}`).emit('dmMessage', {
      userId, coachId, message, senderType, createdAt: at || new Date()
    });
  });
});

// Start the server (with Socket.IO)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});