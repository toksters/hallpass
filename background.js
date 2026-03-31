importScripts('src/storage.js');

const RULE_ID_OFFSET = 1000;
const PASS_CHECK_ALARM = 'hallpass-check-passes';

// --- Rule Management ---

async function rebuildRules() {
  const settings = await hallpassStorage.get('hp_settings');
  const sessions = await hallpassStorage.get('hp_sessions');
  const now = Date.now();

  // Get existing dynamic rule IDs to remove
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  // Build new rules from enabled blocked sites without active passes
  const addRules = [];
  if (settings.enabled) {
    settings.blockedSites.forEach((site, index) => {
      if (!site.enabled) return;

      // Skip if there's an active pass
      const pass = sessions[site.pattern];
      if (pass && pass.expiresAt > now) return;

      addRules.push({
        id: RULE_ID_OFFSET + index,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: `||${site.pattern}`,
          resourceTypes: ['main_frame']
        }
      });
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// --- Session Pass Management ---

async function grantPass(sitePattern) {
  const settings = await hallpassStorage.get('hp_settings');
  const durationMs = (settings.passDuration || 30) * 60 * 1000;
  const now = Date.now();

  await hallpassStorage.update('hp_sessions', sessions => {
    sessions[sitePattern] = {
      grantedAt: now,
      expiresAt: now + durationMs
    };
    return sessions;
  });

  await rebuildRules();
}

async function checkPass(sitePattern) {
  const sessions = await hallpassStorage.get('hp_sessions');
  const pass = sessions[sitePattern];
  if (!pass) return null;

  const now = Date.now();
  if (pass.expiresAt > now) {
    return pass;
  }
  return null;
}

async function cleanExpiredPasses() {
  const now = Date.now();
  let changed = false;

  await hallpassStorage.update('hp_sessions', sessions => {
    for (const pattern of Object.keys(sessions)) {
      if (sessions[pattern].expiresAt <= now) {
        delete sessions[pattern];
        changed = true;
      }
    }
    return sessions;
  });

  if (changed) {
    await rebuildRules();
  }
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'updateRules':
      await rebuildRules();
      return { success: true };

    case 'grantPass':
      await grantPass(message.site);
      return { success: true };

    case 'checkPass': {
      const pass = await checkPass(message.site);
      return { pass };
    }

    case 'getSettings':
      return await hallpassStorage.get('hp_settings');

    case 'getStats':
      return await hallpassStorage.get('hp_stats');

    case 'getSessions':
      return await hallpassStorage.get('hp_sessions');

    case 'toggleEnabled': {
      const settings = await hallpassStorage.update('hp_settings', s => {
        s.enabled = !s.enabled;
        return s;
      });
      await rebuildRules();
      return { enabled: settings.enabled };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// --- Navigation Interception ---

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only intercept top-level navigations
  if (details.frameId !== 0) return;

  const navUrl = details.url;
  // Don't intercept our own block page
  if (navUrl.startsWith(chrome.runtime.getURL(''))) return;

  const settings = await hallpassStorage.get('hp_settings');
  if (!settings.enabled) return;

  const sessions = await hallpassStorage.get('hp_sessions');
  const now = Date.now();

  for (const site of settings.blockedSites) {
    if (!site.enabled) continue;

    try {
      const url = new URL(navUrl);
      if (!url.hostname.includes(site.pattern)) continue;
    } catch {
      continue;
    }

    // Check for active pass
    const pass = sessions[site.pattern];
    if (pass && pass.expiresAt > now) continue;

    // Redirect to block page with full original URL
    const blockUrl = chrome.runtime.getURL(
      `block.html?site=${encodeURIComponent(site.pattern)}&url=${encodeURIComponent(navUrl)}`
    );
    chrome.tabs.update(details.tabId, { url: blockUrl });
    break;
  }
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PASS_CHECK_ALARM) {
    await cleanExpiredPasses();
  }
});

// --- Initialization ---

chrome.runtime.onInstalled.addListener(async () => {
  await rebuildRules();
  // Check passes every minute
  chrome.alarms.create(PASS_CHECK_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  await rebuildRules();
  chrome.alarms.create(PASS_CHECK_ALARM, { periodInMinutes: 1 });
});
