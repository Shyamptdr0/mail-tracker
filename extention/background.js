/**
 * Gmail Tracker Pro - Background Script
 */

const SERVER_URL = 'https://mail-tracker-new-1.onrender.com';
let notifiedIds = new Set();

// Load already notified IDs from storage
chrome.storage.local.get(['notifiedIds'], (res) => {
    if (res.notifiedIds) notifiedIds = new Set(res.notifiedIds);
});

// Function to fetch status and show notifications
function checkStatus() {
    fetch(`${SERVER_URL}/all-status`)
        .then(response => response.json())
        .then(data => {
            let changed = false;
            Object.entries(data).forEach(([id, status]) => {
                if (status.opened && !notifiedIds.has(id)) {
                    notifiedIds.add(id);
                    changed = true;

                    // Show native notification
                    chrome.notifications.create(`mt-open-${id}`, {
                        type: 'basic',
                        iconUrl: 'icon.png',
                        title: status.recipient || 'Someone',
                        message: '✓✓ Email Opened just now!',
                        priority: 2
                    });
                }
            });

            if (changed) {
                chrome.storage.local.set({ notifiedIds: Array.from(notifiedIds) });
                // Notify all tabs to update their UI
                chrome.tabs.query({}, (tabs) => {
                    tabs.forEach(tab => {
                        chrome.tabs.sendMessage(tab.id, { action: 'updateUI' }).catch(() => {});
                    });
                });
            }
        })
        .catch(err => console.error('[MT] Background fetch error:', err));
}

// Poll every 3 seconds for "instant" feel
setInterval(checkStatus, 3000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchStatus') {
        fetch(request.url, { credentials: 'include' })
            .then(response => response.json())
            .then(data => sendResponse({ success: true, data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; 
    }
});
