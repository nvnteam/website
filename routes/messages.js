import express from 'express';
import mongoose from 'mongoose';
import authMiddleware from '../middleware/authMiddleware.js';
import DirectMessage from '../models/DirectMessage.js';
import User from '../models/User.js';
import Coach from '../models/Coach.js';

const router = express.Router();

// GET /api/messages/threads - list user's coach DM threads with last message & unread counts
router.get('/threads', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ error: 'Only users can list coach threads for now' });
    }
    const userId = req.user._id;
    const user = await User.findById(userId).select('my_coaches').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const coachIds = (user.my_coaches || []).map(c => c.coach_id);
    if (!coachIds.length) return res.json([]);

    const coaches = await Coach.find({ _id: { $in: coachIds } })
      .select('name profile_picture')
      .lean();
    const coachMap = new Map(coaches.map(c => [c._id.toString(), c]));

    // Aggregate last message per coach
    const lastMsgs = await DirectMessage.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), coach: { $in: coachIds.map(id => new mongoose.Types.ObjectId(id)) } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$coach', lastMessage: { $first: '$message' }, lastSenderType: { $first: '$senderType' }, lastAt: { $first: '$createdAt' } } }
    ]);
    const lastMap = new Map(lastMsgs.map(m => [m._id.toString(), m]));

    // Unread counts (messages from coach that user has not read)
    const unreadCounts = await DirectMessage.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), coach: { $in: coachIds.map(id => new mongoose.Types.ObjectId(id)) }, senderType: 'coach', readByUser: false } },
      { $group: { _id: '$coach', count: { $sum: 1 } } }
    ]);
    const unreadMap = new Map(unreadCounts.map(u => [u._id.toString(), u.count]));

    const threads = coachIds.map(id => {
      const key = id.toString();
      const coach = coachMap.get(key) || {};
      const last = lastMap.get(key) || {};
      return {
        coachId: key,
        coachName: coach.name || 'Coach',
        coachAvatar: coach.profile_picture || null,
        lastMessage: last.lastMessage || '',
        lastSenderType: last.lastSenderType || null,
        lastAt: last.lastAt || null,
        unread: unreadMap.get(key) || 0
      };
    });

    // Sort by lastAt desc (threads with no messages go to bottom)
    threads.sort((a, b) => (new Date(b.lastAt || 0)) - (new Date(a.lastAt || 0)));
    res.json(threads);
  } catch (err) {
    console.error('❌ Threads error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// GET /api/messages/with/:coachId?page=&limit=
router.get('/with/:coachId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only users can fetch coach DMs for now' });
    const userId = req.user._id;
    const { coachId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const user = await User.findById(userId).select('my_coaches').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const isSubscribed = (user.my_coaches || []).some(c => c.coach_id.toString() === coachId);
    if (!isSubscribed) return res.status(403).json({ error: 'You are not subscribed to this coach' });
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const messages = await DirectMessage.find({ user: userId, coach: coachId })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    res.json(messages);
  } catch (err) {
    console.error('❌ Fetch DM error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/messages/with/:coachId
router.post('/with/:coachId', authMiddleware, async (req, res) => {
  try {
    const { coachId } = req.params;
    const { message } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });

    if (req.user.role === 'user') {
      const userId = req.user._id;
      const user = await User.findById(userId).select('my_coaches').lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      const isSubscribed = (user.my_coaches || []).some(c => c.coach_id.toString() === coachId);
      if (!isSubscribed) return res.status(403).json({ error: 'You are not subscribed to this coach' });
      const doc = await DirectMessage.create({
        user: userId,
        coach: coachId,
        senderType: 'user',
        message: String(message).trim(),
        readByUser: true,
        readByCoach: false
      });
      return res.status(201).json(doc);
    }

    if (req.user.role === 'coach') {
      // Optional: allow coach to send to subscriber (requires ?userId in body)
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId is required for coaches' });
      const coach = await Coach.findById(req.user._id).select('subscribers').lean();
      if (!coach) return res.status(404).json({ error: 'Coach not found' });
      const isSubscriber = (coach.subscribers || []).some(id => id.toString() === userId);
      if (!isSubscriber) return res.status(403).json({ error: 'User is not your subscriber' });
      const doc = await DirectMessage.create({
        user: userId,
        coach: coachId,
        senderType: 'coach',
        message: String(message).trim(),
        readByUser: false,
        readByCoach: true
      });
      return res.status(201).json(doc);
    }

    return res.status(403).json({ error: 'Unauthorized role' });
  } catch (err) {
    console.error('❌ Send DM error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/messages/mark-read/:coachId - mark messages from coach as read by user
router.post('/mark-read/:coachId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only users can mark read' });
    const userId = req.user._id;
    const { coachId } = req.params;
    await DirectMessage.updateMany({ user: userId, coach: coachId, senderType: 'coach', readByUser: false }, { $set: { readByUser: true } });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

export default router;

