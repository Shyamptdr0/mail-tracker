const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mailtrack';

// MongoDB Connection
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));// Tracking Schema (Professional Version)
const trackingSchema = new mongoose.Schema({
    trackingId: { type: String, required: true, unique: true },
    recipient: { type: String, default: 'Someone' },
    senderId: { type: String },
    senderIp: { type: String },
    registeredAt: { type: Date, default: Date.now },
    isSent: { type: Boolean, default: false }, // New flag to prevent pre-send triggers
    
    // Summary data
    opened: { type: Boolean, default: false },
    firstOpenedAt: { type: Date },
    lastOpenedAt: { type: Date },
    totalOpens: { type: Number, default: 0 },
    
    // Detailed history
    opens: [{
        at: { type: Date, default: Date.now },
        ip: String,
        ua: String,
        device: String, // Desktop, Mobile, Tablet
        isProxy: Boolean
    }],
    
    // Raw hits (including proxies/self-opens for debugging)
    hits: [{
        at: { type: Date, default: Date.now },
        ip: String,
        ua: String,
        reason: String
    }]
});

const Tracking = mongoose.model('Tracking', trackingSchema);

// Helper to detect device type
function getDeviceType(ua) {
    if (!ua) return 'Unknown';
    if (/mobile/i.test(ua)) return 'Mobile';
    if (/tablet/i.test(ua)) return 'Tablet';
    return 'Desktop';
}

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// 1x1 Transparent Pixel (Base64)
const PIXEL_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const pixelBuffer = Buffer.from(PIXEL_BASE64, 'base64');

/**
 * Init Sender Endpoint
 */
app.get('/init-sender', (req, res) => {
    let senderId = req.cookies.mt_sender;
    
    if (!senderId || senderId === 'true' || senderId.length < 10) {
        senderId = uuidv4();
    }

    res.cookie('mt_sender', senderId, {
        maxAge: 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
        httpOnly: true,
        sameSite: 'none',
        secure: true
    });
    res.json({ success: true, senderId });
});

/**
 * Registration Endpoint
 */
app.get('/register/:id', async (req, res) => {
    try {
        const trackingId = req.params.id;
        const recipient = req.query.to || 'Someone';
        const senderId = req.cookies.mt_sender;
        const senderIp = req.ip;
        const isSent = req.query.sent === 'true';

        await Tracking.findOneAndUpdate(
            { trackingId },
            { 
                recipient, 
                senderId,
                senderIp,
                registeredAt: Date.now(),
                isSent: isSent // Only true when the mail is actually sent
            },
            { upsert: true, new: true }
        );

        console.log(`[REGISTER] ID: ${trackingId} | Sent: ${isSent} | For: ${recipient}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Tracking Endpoint (Professional Logic)
 */
app.get('/track/:id', async (req, res) => {
    let trackingId = req.params.id;
    if (trackingId.endsWith('.png')) {
        trackingId = trackingId.replace('.png', '');
    }

    const userAgent = req.get('User-Agent') || '';
    const ip = req.ip;
    const senderCookie = req.cookies.mt_sender;

    try {
        const tracking = await Tracking.findOne({ trackingId });

        if (!tracking) {
            res.set('Content-Type', 'image/png');
            return res.send(pixelBuffer);
        }

        // 1. Detection Logic
        const isSender = senderCookie && tracking.senderId === senderCookie;
        const isProxy =
            userAgent.includes('GoogleImageProxy') ||
            userAgent.includes('YahooMailProxy') ||
            userAgent.includes('via ggpht.com') ||
            userAgent.includes('googleusercontent') ||
            userAgent.toLowerCase().includes('proxy') ||
            userAgent.toLowerCase().includes('fetch') ||
            userAgent.toLowerCase().includes('bot');

        const timeSinceRegistration = Date.now() - new Date(tracking.registeredAt).getTime();
        const isCooldown = timeSinceRegistration < 30000; // 30s strict cooldown

        // CRITICAL: Only mark as opened if it's explicitly SENT
        let isValidOpen = tracking.isSent && !isSender && !isProxy && !isCooldown && userAgent.length > 10;

        let statusReason = "";
        if (!tracking.isSent) statusReason = "Not Sent Yet";
        else if (isSender) statusReason = "Sender";
        else if (isProxy) statusReason = "Proxy";
        else if (isCooldown) statusReason = "Cooldown";
        else if (userAgent.length <= 10) statusReason = "Invalid UA";
        else statusReason = "Valid Open";

        // 2. Update Record
        if (isValidOpen) {
            const now = new Date();
            tracking.opened = true;
            if (!tracking.firstOpenedAt) tracking.firstOpenedAt = now;
            tracking.lastOpenedAt = now;
            tracking.totalOpens += 1;
            
            tracking.opens.push({
                at: now,
                ip,
                ua: userAgent,
                device: getDeviceType(userAgent),
                isProxy: false
            });

            console.log(`✅ [READ] ${tracking.recipient} opened ${trackingId} (${getDeviceType(userAgent)})`);
        }

        // Log every hit for debugging
        tracking.hits.push({
            at: Date.now(),
            ip,
            ua: userAgent,
            reason: statusReason
        });

        await tracking.save();

    } catch (error) {
        console.error('Tracking Error:', error);
    }

    // Always send the 1x1 transparent pixel
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(pixelBuffer);
});


/**
 * Status Check Endpoint
 */
app.get('/status/:id', async (req, res) => {
    try {
        const tracking = await Tracking.findOne({ trackingId: req.params.id });
        if (!tracking) return res.status(404).json({ error: 'Not found' });

        res.json({
            id: tracking.trackingId,
            opened: tracking.opened,
            totalOpens: tracking.totalOpens,
            firstOpen: tracking.firstOpenedAt,
            lastOpen: tracking.lastOpenedAt,
            recipient: tracking.recipient,
            history: tracking.opens
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Bulk Status Check Endpoint
 */
app.get('/all-status', async (req, res) => {
    try {
        const all = await Tracking.find({});
        const data = {};
        all.forEach(t => {
            data[t.trackingId] = {
                opened: t.opened,
                totalOpens: t.totalOpens,
                lastOpen: t.lastOpenedAt,
                recipient: t.recipient
            };
        });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Professional Tracker Server running on port ${PORT}`);
});

