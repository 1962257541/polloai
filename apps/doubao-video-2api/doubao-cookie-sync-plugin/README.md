# 豆包 Cookie 同步插件

这个 Chrome/Edge 插件用于把当前浏览器里已登录的豆包 Cookie 同步到 Doubao2API 后端。

## 安装

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择这个文件夹：`doubao-cookie-sync-plugin`。

## 配置

打开 Doubao2API 插件同步页面：

```text
http://你的后端地址:8088/plugin-sync
```

复制页面里的：

- 后端同步地址
- 连接令牌

粘贴到插件弹窗里，点击 `保存配置`。

浏览器里登录豆包后，点击 `立即同步` 就会自动保存当前填写的地址和令牌并立即同步。插件默认每天本地时间 `00:00` 自动同步一次。
