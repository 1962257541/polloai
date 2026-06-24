const DEFAULT_CONFIG = {
  apiUrl: "http://127.0.0.1:8088/v1/doubao-cookie-plugin/update-cookie",
  connectionToken: "",
  syncHour: 0,
  syncMinute: 0,
  settleSeconds: 5,
};

const $ = id => document.getElementById(id);

const ACTION_TEXT = {
  added: "新增账号",
  updated: "更新账号",
  unchanged: "无需更新",
  ok: "成功",
};

const LEVEL_TEXT = {
  info: "信息",
  error: "错误",
  warn: "警告",
};

function friendlyError(message) {
  const text = String(message || "");
  const pairs = [
    ["Unable to save config", "保存配置失败"],
    ["Sync failed", "同步失败"],
    ["API URL or connection token is not configured", "后端同步地址或连接令牌未配置"],
    ["No logged-in Doubao cookie found. Please log in to Doubao in this Chrome profile.", "未找到已登录的豆包 Cookie，请先在当前浏览器登录豆包。"],
    ["Timed out waiting for Doubao page load", "等待豆包页面加载超时"],
    ["Invalid plugin connection token.", "插件连接令牌无效"],
    ["Missing Doubao cookie.", "未获取到豆包 Cookie"],
    ["Cookie does not contain a logged-in Doubao session.", "Cookie 中没有登录态，请先登录豆包。"],
  ];
  for (const [source, target] of pairs) {
    if (text.includes(source)) return target;
  }
  return text.replace("Backend returned", "后端返回");
}

function setStatus(message, error = false) {
  $("status").textContent = message || "";
  $("status").style.color = error ? "#ef233c" : "#00a35c";
}

function configFromForm() {
  return {
    apiUrl: $("apiUrl").value.trim(),
    connectionToken: $("connectionToken").value.trim(),
    syncHour: Math.min(23, Math.max(0, Number($("syncHour").value || 0))),
    syncMinute: Math.min(59, Math.max(0, Number($("syncMinute").value || 0))),
    settleSeconds: Math.min(30, Math.max(0, Number($("settleSeconds").value || 5))),
  };
}

async function sendMessage(message) {
  return await chrome.runtime.sendMessage(message);
}

async function loadConfig() {
  const config = {
    ...DEFAULT_CONFIG,
    ...(await chrome.storage.sync.get(Object.keys(DEFAULT_CONFIG))),
  };
  $("apiUrl").value = config.apiUrl;
  $("connectionToken").value = config.connectionToken;
  $("syncHour").value = config.syncHour;
  $("syncMinute").value = config.syncMinute;
  $("settleSeconds").value = config.settleSeconds;
  await renderLogs();
}

async function saveConfig() {
  $("save").disabled = true;
  try {
    const result = await sendMessage({ action: "saveConfig", config: configFromForm() });
    if (!result?.success) throw new Error(result?.error || "保存配置失败");
    setStatus("已保存，定时同步已重设。");
  } catch (error) {
    setStatus(friendlyError(error.message), true);
  } finally {
    $("save").disabled = false;
    await renderLogs();
  }
}

async function testNow() {
  $("test").disabled = true;
  setStatus("正在同步...");
  try {
    const saved = await sendMessage({ action: "saveConfig", config: configFromForm() });
    if (!saved?.success) throw new Error(saved?.error || "保存配置失败");
    const result = await sendMessage({ action: "testNow" });
    if (!result?.success) throw new Error(result?.error || "同步失败");
    setStatus(`同步成功：${ACTION_TEXT[result.action] || result.action || "成功"}；账号数 ${result.account_count || "-"}`);
  } catch (error) {
    setStatus(friendlyError(error.message), true);
  } finally {
    $("test").disabled = false;
    await renderLogs();
  }
}

async function renderLogs() {
  const result = await sendMessage({ action: "getLogs" });
  const logs = result?.logs || [];
  $("logs").innerHTML = logs.length
    ? logs.map(item => {
      const time = new Date(item.time).toLocaleTimeString();
      return `<div><b>${time}</b> [${LEVEL_TEXT[item.level] || item.level}] ${friendlyError(item.message)}</div>`;
    }).join("")
    : "<div>暂无日志。</div>";
}

async function clearLogs() {
  await sendMessage({ action: "clearLogs" });
  await renderLogs();
  setStatus("日志已清空。");
}

$("save").addEventListener("click", saveConfig);
$("test").addEventListener("click", testNow);
$("clearLogs").addEventListener("click", clearLogs);

loadConfig().catch(error => setStatus(friendlyError(error.message), true));
