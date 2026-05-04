(function () {
    'use strict';

    const SERVER_URL = 'https://mail-tracker-new-1.onrender.com';
    const TICKS_CLASS = 'mt-ticks-container';

    let openedIds = new Set();
    let threadMap = {}; // threadId -> trackingId

    // Load saved data and THEN start processing
    chrome.storage.local.get(['notifiedIds', 'threadMap'], (res) => {
        if (res.notifiedIds) openedIds = new Set(res.notifiedIds);
        if (res.threadMap) threadMap = res.threadMap;
        console.log('[MT] Data loaded from storage. Threads:', Object.keys(threadMap).length);
        processPage(); // Run once after data is ready
    });

    function generateTrackingId() {
        return 'mt-' + Math.random().toString(36).slice(2) + Date.now();
    }

    function getRecipient(composeBody) {
        try {
            const container = composeBody.closest('div.M9, div.AD');
            const el = container?.querySelector('[email]');
            return el?.getAttribute('email') || 'Someone';
        } catch {
            return 'Someone';
        }
    }

    function getThreadId(row) {
        // Try multiple ways to get the thread ID
        return row.getAttribute('data-thread-id') || 
               row.getAttribute('data-legacy-thread-id') || 
               row.id;
    }

    // =========================
    // 📌 PIXEL INJECTION
    // =========================
    function injectPixel(composeBody) {
        if (composeBody.querySelector('.mailtrack-img')) return;

        const id = generateTrackingId();
        const recipient = getRecipient(composeBody);

        const img = document.createElement('img');
        img.src = `${SERVER_URL}/track/${id}.png`;
        img.style.display = 'none';
        img.className = 'mailtrack-img';
        img.dataset.id = id;

        composeBody.appendChild(img);

        // Register on server
        if (chrome.runtime?.id) {
            chrome.runtime.sendMessage({
                action: 'fetchStatus',
                url: `${SERVER_URL}/register/${id}?to=${encodeURIComponent(recipient)}`
            });
            
            // Mark as recently sent to help fallback mapping
            window._lastMTId = id;
        }

        console.log('[MT] Pixel injected:', id);
    }

    // =========================
    // 📌 SEND DETECTION
    // =========================
    function handleSend(composeBody) {
        const pixel = composeBody.querySelector('.mailtrack-img');
        if (!pixel) return;

        const trackingId = pixel.dataset.id;
        const recipient = getRecipient(composeBody);

        console.log('[MT] Marking as SENT:', trackingId);

        // Notify server that mail is actually being sent NOW
        if (chrome.runtime?.id) {
            chrome.runtime.sendMessage({
                action: 'fetchStatus',
                url: `${SERVER_URL}/register/${trackingId}?to=${encodeURIComponent(recipient)}&sent=true`
            });
        }

        // Fallback: Map thread after a delay
        setTimeout(() => {
            const rows = document.querySelectorAll('.zA, [role="grid"] tr[id], .v7');
            rows.forEach(row => {
                const threadId = getThreadId(row);
                if (threadId && !threadMap[threadId]) {
                    threadMap[threadId] = trackingId;
                }
            });

            if (chrome.runtime?.id) {
                chrome.storage.local.set({ threadMap });
            }
            processPage();
        }, 3000);
    }

    function attachSendListener(composeBody) {
        const box = composeBody.closest('div.M9, div.AD');
        if (!box || box.dataset.mtAttached) return;

        // 1. Click Listener (Multiple selectors for robustness)
        const sendBtn = box.querySelector('[data-tooltip*="Send"], .T-I-KE, [role="button"]:not([data-tooltip]):not([aria-label]):not([id])');
        
        sendBtn?.addEventListener('click', () => handleSend(composeBody));

        // 2. Keyboard Listener (Ctrl+Enter / Cmd+Enter)
        composeBody.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                handleSend(composeBody);
            }
        });

        box.dataset.mtAttached = 'true';
    }

    // =========================
    // 📌 TICKS UI
    // =========================
    function injectTicks(row) {
        if (row.querySelector(`.${TICKS_CLASS}`)) {
            updateTick(row);
            return;
        }

        const sender = row.querySelector('.yX');
        if (!sender) return;

        const container = document.createElement('span');
        container.className = TICKS_CLASS;

        const tick = document.createElement('span');
        tick.className = 'mt-double-tick mt-double-tick-gray';
        tick.title = 'Sent (Tracking)';

        container.appendChild(tick);

        sender.style.display = 'inline-flex';
        sender.style.alignItems = 'center';

        sender.prepend(container);

        updateTick(row);
    }

    function updateTick(row) {
        const threadId = getThreadId(row);
        const trackingId = threadMap[threadId];

        const tick = row.querySelector('.mt-double-tick');
        if (!tick || !trackingId) return;

        if (openedIds.has(trackingId)) {
            tick.classList.remove('mt-double-tick-gray');
            tick.classList.add('mt-double-tick-green');
            tick.title = 'Opened';
        }
    }

    // =========================
    // 📌 PAGE SCAN
    // =========================
    function processPage() {
        // Compose windows
        document
            .querySelectorAll('div[contenteditable="true"][role="textbox"]')
            .forEach(cb => {
                injectPixel(cb);
                attachSendListener(cb);
            });

        // Scan for threads (Gmail's main list rows)
        // Using both .zA and specific role for robustness
        const rows = document.querySelectorAll('.zA, [role="grid"] tr[id], .v7');
        rows.forEach(row => {
            const threadId = getThreadId(row);
            if (threadId && !threadMap[threadId] && window._lastMTId) {
                // Auto-map if we just sent something and see a new row
                threadMap[threadId] = window._lastMTId;
                if (chrome.runtime?.id) {
                    chrome.storage.local.set({ threadMap });
                }
                console.log('[MT] Fallback mapping successful:', threadId);
            }
            injectTicks(row);
        });
    }

    // =========================
    // 📌 FETCH STATUS (Now handled by background, this is for UI updates)
    // =========================
    function syncStatus() {
        chrome.storage.local.get(['notifiedIds'], (res) => {
            if (res.notifiedIds) {
                openedIds = new Set(res.notifiedIds);
                processPage();
            }
        });
    }

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'updateUI') {
            syncStatus();
        }
    });

    // =========================
    // 📌 NOTIFICATIONS (Moved to background.js)
    // =========================
    // removed showNotification function

    // =========================
    // 📌 INIT
    // =========================
    const observer = new MutationObserver(processPage);

    function init() {
        if (chrome.runtime?.id) {
            chrome.runtime.sendMessage({
                action: 'fetchStatus',
                url: `${SERVER_URL}/init-sender`
            });
        }

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // initial sync
        syncStatus();
    }

    init();
    window.addEventListener('hashchange', processPage);

})();