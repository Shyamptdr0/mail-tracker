const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mailtrack';

// MongoDB Connection
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Tracking Schema
const trackingSchema = new mongoose.Schema({
    trackingId: { type: String, required: true, unique: true },
    recipient: { type: String, default: 'Someone' },
    senderId: { type: String },
    opened: { type: Boolean, default: false },
    registeredAt: { type: Date, default: Date.now },
    openedAt: { type: Date },
    ip: { type: String },
    userAgent: { type: String },
    hits: [{
        at: { type: Date, default: Date.now },
        ip: String,
        ua: String,
        isProxy: Boolean
    }]
});

const Tracking = mongoose.model('Tracking', trackingSchema);

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
 * Sets a unique sender ID cookie to prevent self-opens.
 */
app.get('/init-sender', (req, res) => {
    let senderId = req.cookies.mt_sender;
    
    if (!senderId || senderId === 'true') {
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

        await Tracking.findOneAndUpdate(
            { trackingId },
            { 
                recipient, 
                senderId,
                registeredAt: Date.now()
            },
            { upsert: true, new: true }
        );

        console.log(`Tracking ID Registered: ${trackingId} (For: ${recipient})`);
        res.json({ success: true });
    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Tracking Endpoint
 */
app.get('/track/:id', async (req, res) => {
    let trackingId = req.params.id;
    if (trackingId.endsWith('.png')) {
        trackingId = trackingId.replace('.png', '');
    }

    const userAgent = req.get('User-Agent') || '';
    const ip = req.ip;
    const senderCookie = req.cookies.mt_sender;

    console.log(`--- Tracking Request: ${trackingId} ---`);

    try {
        const tracking = await Tracking.findOne({ trackingId });

        if (!tracking) {
            console.log(`>>> Warning: Tracking ID ${trackingId} not found in DB`);
            // Still send pixel
            res.set('Content-Type', 'image/png');
            return res.send(pixelBuffer);
        }

        // Detect if this is a self-open
        const isSender = senderCookie && tracking.senderId === senderCookie;

        // Detect proxies
        const isProxy = userAgent.includes('GoogleImageProxy') ||
            userAgent.includes('YahooMailProxy') ||
            userAgent.includes('via ggpht.com') ||
            userAgent.includes('facebookexternalhit');

        // Logic: Mark as opened only if NOT sender AND NOT proxy
        // (We can also allow proxies if they happen long after registration, but usually proxies are just pre-scans)
        
        let shouldMarkOpened = !isSender && !isProxy && !tracking.opened;

        // Record the hit anyway for debugging
        tracking.hits.push({
            at: Date.now(),
            ip,
            ua: userAgent,
            isProxy
        });

        if (shouldMarkOpened) {
            tracking.opened = true;
            tracking.openedAt = Date.now();
            tracking.ip = ip;
            tracking.userAgent = userAgent;
            console.log(`✅ [OPENED] Recipient opened email: ${trackingId}`);
        } else {
            if (isSender) console.log(`>>> Ignored: Self-open`);
            if (isProxy) console.log(`>>> Ignored: Proxy/Bot scan`);
            if (tracking.opened) console.log(`>>> Info: Already marked as opened`);
        }

        await tracking.save();

    } catch (error) {
        console.error('Tracking Error:', error);
    }

    // Always send pixel
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
        res.json({
            id: req.params.id,
            opened: tracking ? tracking.opened : false,
            openedAt: tracking ? tracking.openedAt : null,
            recipient: tracking ? tracking.recipient : null
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
                openedAt: t.openedAt,
                recipient: t.recipient
            };
        });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

