/**
 * Gmail Tracker Pro - Background Script
 * Handles cross-origin fetches to avoid Mixed Content restrictions in content scripts.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchStatus') {
        fetch(request.url, { credentials: 'include' })
            .then(response => response.json())
            .then(data => sendResponse({ success: true, data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep the message channel open for async response
    }
});
