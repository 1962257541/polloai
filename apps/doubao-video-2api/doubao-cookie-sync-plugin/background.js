const ALARM_NAME = "doubaoCookieSyncDaily";
const DEFAULT_CONFIG = {
  apiUrl: "http://127.0.0.1:8088/v1/doubao-cookie-plugin/update-cookie",
  connectionToken: "",
  syncHour: 0,
  syncMinute: 0,
  settleSeconds: 5,
};

const LOGIN_COOKIE_NAMES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "sid_guard",
  "uid_tt",
  "uid_tt_ss",
  "passport_user_id",
  "user_unique_id",
  "login_user_id",
]);

function friendlyBackendError(status, result = {}) {
  const text = String(result.detail || result.message || "");
  if (text.includes("Invalid plugin connection token")) return "插件连接令牌无效，请重新复制后端页面里的令牌。";
  if (text.includes("Missing Doubao cookie")) return "未获取到豆包 Cookie。";
  if (text.includes("line breaks")) return "Cookie 不能包含换行。";
  if (text.includes("logged-in Doubao session")) return "Cookie 中没有登录态，请先登录豆包。";
  if (text) return text;
  return `后端返回 ${status}`;
}

async function log(level, message, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    details,
  };
  console[level === "error" ? "error" : "log"]("[豆包 Cookie 同步]", entry);
  const stored = await chrome.storage.local.get({ logs: [] });
  const logs = [entry, ...stored.logs].slice(0, 80);
  await chrome.storage.local.set({ logs });
}

async function getConfig() {
  return {
    ...DEFAULT_CONFIG,
    ...(await chrome.storage.sync.get(Object.keys(DEFAULT_CONFIG))),
  };
}

function nextRunTime(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function setupAlarm() {
  const config = await getConfig();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    when: nextRunTime(config.syncHour, config.syncMinute),
    periodInMinutes: 24 * 60,
  });
  await log("info", "每日同步任务已设置", {
    syncHour: Number(config.syncHour) || 0,
    syncMinute: Number(config.syncMinute) || 0,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("等待豆包页面加载超时"));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function collectDoubaoCookies() {
  const sources = [
    chrome.cookies.getAll({ url: "https://www.doubao.com/" }),
    chrome.cookies.getAll({ url: "https://www.doubao.com/chat/" }),
    chrome.cookies.getAll({ domain: ".doubao.com" }),
    chrome.cookies.getAll({ domain: "doubao.com" }),
  ];
  const batches = await Promise.allSettled(sources);
  const merged = new Map();
  for (const batch of batches) {
    if (batch.status !== "fulfilled") continue;
    for (const cookie of batch.value || []) {
      if (!cookie.name) continue;
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      merged.set(key, cookie);
    }
  }
  return [...merged.values()];
}

function cookieHeader(cookies) {
  return cookies
    .filter(cookie => cookie.name && cookie.value !== undefined)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function hasLoginCookie(cookies) {
  return cookies.some(cookie => LOGIN_COOKIE_NAMES.has(String(cookie.name || "").toLowerCase()));
}

async function extractAndSendCookie() {
  let tab = null;
  try {
    const config = await getConfig();
    if (!config.apiUrl || !config.connectionToken) {
      throw new Error("后端同步地址或连接令牌未配置");
    }

    await log("info", "正在打开豆包页面");
    tab = await chrome.tabs.create({
      url: "https://www.doubao.com/chat/",
      active: false,
    });
    await waitForTabComplete(tab.id);
    await sleep(Math.max(0, Number(config.settleSeconds) || 0) * 1000);

    const cookies = await collectDoubaoCookies();
    const names = cookies.map(cookie => ({ name: cookie.name, domain: cookie.domain }));
    await log("info", "已读取豆包 Cookie", { count: cookies.length, names });

    if (!hasLoginCookie(cookies)) {
      throw new Error("未找到已登录的豆包 Cookie，请先在当前浏览器登录豆包。");
    }

    const header = cookieHeader(cookies);
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.connectionToken}`,
      },
      body: JSON.stringify({
        cookie: header,
        source: "chrome_extension",
        persist: true,
      }),
    });

    const bodyText = await response.text();
    let result = {};
    try {
      result = JSON.parse(bodyText || "{}");
    } catch {
      result = { raw: bodyText };
    }
    if (!response.ok) {
      throw new Error(friendlyBackendError(response.status, result));
    }

    await log("info", "Cookie 已同步", {
      action: result.action,
      account_count: result.account_count,
      env_index: result.env_index,
    });
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.svg",
      title: "豆包 Cookie 同步",
      message: `同步成功；账号数 ${result.account_count || "-"}`,
    });
    return { success: true, ...result };
  } catch (error) {
    await log("error", "Cookie 同步失败", { error: error.message });
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.svg",
      title: "豆包 Cookie 同步失败",
      message: error.message,
    });
    return { success: false, error: error.message };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {}
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarm();
  await log("info", "插件已安装");
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    await extractAndSendCookie();
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "saveConfig") {
    chrome.storage.sync.set(request.config || {}).then(setupAlarm).then(() => {
      sendResponse({ success: true });
    }).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (request.action === "testNow") {
    extractAndSendCookie().then(sendResponse);
    return true;
  }
  if (request.action === "getLogs") {
    chrome.storage.local.get({ logs: [] }).then(sendResponse);
    return true;
  }
  if (request.action === "clearLogs") {
    chrome.storage.local.set({ logs: [] }).then(() => sendResponse({ logs: [] }));
    return true;
  }
});
