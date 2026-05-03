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
    // 📌 SEND BUTTON LISTENER
    // =========================
    function attachSendListener(composeBody) {
        const box = composeBody.closest('div.M9, div.AD');
        if (!box || box.dataset.mtAttached) return;

        const sendBtn = box.querySelector('[data-tooltip*="Send"]');

        sendBtn?.addEventListener('click', () => {
            const pixel = composeBody.querySelector('.mailtrack-img');
            if (!pixel) return;

            const trackingId = pixel.dataset.id;

            // Wait for Gmail to create thread (increased timeout for reliability)
            setTimeout(() => {
                document.querySelectorAll('.zA').forEach(row => {
                    const threadId = getThreadId(row);
                    if (threadId && !threadMap[threadId]) {
                        threadMap[threadId] = trackingId;
                    }
                });

                if (chrome.runtime?.id) {
                    chrome.storage.local.set({ threadMap });
                }

                console.log('[MT] Thread map updated:', threadMap);
                processPage(); // Force UI update to show ticks
            }, 3000);
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

        // Scan for new threads that might have been missed
        document.querySelectorAll('.zA').forEach(row => {
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
    // 📌 FETCH STATUS
    // =========================
    function fetchStatus() {
        if (!chrome.runtime?.id) return; // Stop if extension reloaded
        
        chrome.runtime.sendMessage(
            { action: 'fetchStatus', url: `${SERVER_URL}/all-status` },
            (res) => {
                if (!res?.success) return;

                let changed = false;

                Object.entries(res.data).forEach(([id, data]) => {
                    if (data.opened && !openedIds.has(id)) {
                        openedIds.add(id);
                        changed = true;

                        showNotification(
                            data.recipient || 'Someone',
                            '✓✓ Email Opened'
                        );
                    }
                });

                if (changed && chrome.runtime?.id) {
                    chrome.storage.local.set({
                        notifiedIds: [...openedIds]
                    });

                    processPage();
                }
            }
        );
    }

    // =========================
    // 📌 NOTIFICATIONS
    // =========================
    function showNotification(title, message) {
        if (Notification.permission === 'granted') {
            new Notification(title, {
                body: message,
                icon: 'https://cdn-icons-png.flaticon.com/512/190/190411.png'
            });
        } else {
            Notification.requestPermission();
        }
    }

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

        // processPage() is now called inside the storage callback above
        setInterval(fetchStatus, 5000);
    }

    init();
    window.addEventListener('hashchange', processPage);

})();