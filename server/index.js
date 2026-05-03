const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 3000;

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// In-memory database for tracking status
// In production, use MongoDB or a similar database
const trackingData = {};

// 1x1 Transparent Pixel (Base64)
const PIXEL_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const pixelBuffer = Buffer.from(PIXEL_BASE64, 'base64');

/**
 * Init Sender Endpoint
 * Sets a cookie to identify the sender's browser and prevent self-opens.
 */
app.get('/init-sender', (req, res) => {
    res.cookie('mt_sender', 'true', {
        maxAge: 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
        httpOnly: true,
        sameSite: 'none',
        secure: true
    });
    res.json({ success: true });
});

/**
 * Registration Endpoint
 * Called by the extension when a new tracking ID is generated.
 */
app.get('/register/:id', (req, res) => {
    const trackingId = req.params.id;
    const recipient = req.query.to || 'Someone';

    trackingData[trackingId] = {
        opened: false,
        registeredAt: Date.now(),
        senderId: req.cookies.mt_sender,
        recipient: recipient
    };
    console.log(`Tracking ID Registered: ${trackingId} (For: ${recipient})`);
    res.json({ success: true });
});

/**
 * Tracking Endpoint
 */
app.get('/track/:id', (req, res) => {
    let trackingId = req.params.id;
    if (trackingId.endsWith('.png')) {
        trackingId = trackingId.replace('.png', '');
    }

    console.log(`--- Tracking Request Received ---`);
    console.log(`ID: ${trackingId}`);
    console.log(`IP: ${req.ip}`);
    console.log(`User-Agent: ${req.get('User-Agent')}`);
    console.log(`Cookies: ${JSON.stringify(req.cookies)}`);

    // Detect if this is a self-open via cookie
    const senderCookie = req.cookies.mt_sender;
    const isSender = senderCookie && trackingData[trackingId] && trackingData[trackingId].senderId === senderCookie;

    // Detect mail proxies
    const userAgent = req.get('User-Agent') || '';
    const isProxy = userAgent.includes('GoogleImageProxy') ||
        userAgent.includes('YahooMailProxy') ||
        userAgent.includes('via ggpht.com');

    // Threshold: Ignore proxy requests within first 10 seconds (often automatic bot scans)
    const timeSinceRegistration = Date.now() - (trackingData[trackingId]?.registeredAt || 0);
    const isTooEarly = timeSinceRegistration < 10000; 

    if (isSender) {
        console.log(`>>> Ignored: Self-open detected (Sender Cookie)`);
        return res.sendFile(pixelPath);
    }

    if (isProxy && isTooEarly) {
        console.log(`>>> Ignored: Early bot scan (Proxy detected)`);
        return res.sendFile(pixelPath);
    }

    if (!trackingData[trackingId]) {
        trackingData[trackingId] = {};
    }

    if (!trackingData[trackingId].opened) {
        trackingData[trackingId] = {
            ...trackingData[trackingId],
            opened: true,
            openedAt: new Date().toISOString(),
            ip: req.ip,
            userAgent: req.get('User-Agent')
        };
    } else {
        console.log(`>>> INFO: Email was already opened.`);
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(pixelBuffer);
});

/**
 * Status Check Endpoint
 * Used by the extension to check if an email was opened.
 */
app.get('/status/:id', (req, res) => {
    const trackingId = req.params.id;
    const data = trackingData[trackingId];

    res.json({
        id: trackingId,
        opened: !!data,
        openedAt: data ? data.openedAt : null
    });
});

/**
 * Bulk Status Check Endpoint
 */
app.get('/all-status', (req, res) => {
    res.json(trackingData);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
