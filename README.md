# Chat Demo WebView 套壳

把 `C:\Other\tools\chat-demo` 里的静态站点原样打包进 APK，用系统 WebView 打开。
**页面和所有静态资源都来自 APK 内部的 assets，不加载任何远程页面。**

## 结构

```
app/src/main/
├── AndroidManifest.xml
├── java/com/example/chatdemo/MainActivity.java   # 唯一的 Java 文件
├── res/                                          # 主题、字符串、启动图标
└── assets/                                       # 原样复制的网站（index.html + static/）
```

`assets/index.html` 直接位于 assets 根目录，所以在 WebView 里 `/static/...`
这类以根路径引用的资源也能正确解析。

## 加载方式

`MainActivity` 使用 `androidx.webkit` 的 **WebViewAssetLoader**，把所有 assets
映射到虚拟域名 `https://appassets.androidplatform.net/`：

```java
new WebViewAssetLoader.Builder()
        .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();
```

页面地址是 `https://appassets.androidplatform.net/index.html`，请求在
`shouldInterceptRequest` 中被拦截并直接返回 APK 内的文件。

为什么不用 `file:///android_asset/index.html`：

- `file://` 页面的 origin 是 `null`，`fetch/XHR` 请求 API 时会被 CORS 拒绝；
- `localStorage`、Cookie 等行为在 `file://` 下不可靠；
- 虚拟 https 源与浏览器环境一致，Web 应用不需要任何改动。

注意：这里的 `appassets.androidplatform.net` 是 WebViewAssetLoader 保留的虚拟域名，
不会产生网络请求，与「远程 URL」无关。

## 构建

需要 JDK 17 + Android SDK（Platform 35 / Build-Tools 35.0.0）。

> 本机 PATH 上的默认 Java 是 25，Gradle 8.9 不支持它。命令行构建前请先设置：
> `set JAVA_HOME=C:\Program Files\Java\jdk-17`

```bat
gradlew.bat assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

用 Android Studio 打开本目录也可以直接构建运行；如果没有 `local.properties`，
Studio 会自动生成。

## 更新网页内容

网页有改动时，把新构建的产物重新复制进 assets 即可（保留目录结构）：

```bat
robocopy "C:\Other\tools\chat-demo" "app\src\main\assets" /MIR
```

注意 `/MIR` 会删除 assets 里多余的文件，确保只放网站内容。

## 已桥接的浏览器能力

- **文件选择**：重写了 `WebChromeClient.onShowFileChooser`，系统文件选择器支持
  单选/多选（取决于 `multiple`），并把 `accept` 转成选择器过滤条件。
  页面里的「上传文件」和「导入历史对话（.zip）」都可以正常使用。
  由于 Android 选择器按 MIME 而不是扩展名过滤，`accept` 里出现 `.zip` 这类
  扩展名时会放开为 `*/*`，由页面自行校验文件类型。
- **麦克风**：声明 `RECORD_AUDIO` 和 `MODIFY_AUDIO_SETTINGS` 权限，
  `onPermissionRequest` 中只放行 `RESOURCE_AUDIO_CAPTURE`。首次点击「语音输入」
  会弹出系统授权框，授权后 `getUserMedia({audio:true})` 才能拿到音频流。
  缺少 `MODIFY_AUDIO_SETTINGS` 时 WebView 会报 `Unable to select audio device`
  （页面侧表现为 `NotReadableError`），即使 `RECORD_AUDIO` 已授权。

## 当前实现的边界

- 只支持文件与麦克风；摄像头/视频采集会被拒绝（`RESOURCE_VIDEO_CAPTURE`）。
- 麦克风被永久拒绝后不会弹自定义引导，页面会收到 `NotAllowedError`。
- **外部链接**：非本地域名的 http/https 链接会用系统浏览器打开。
- **返回键**：WebView 可后退时优先后退，否则退出应用。
- **竖屏旋转**：通过 `configChanges` 保持页面不重建。


## 模拟器验证结果（2026-11-21）

AVD `chatdemo_test`（Android 15 / API 35 / x86_64，WHPX 硬件加速）：

- App 启动后页面正常渲染，所有资源来自 APK 内部
- **文件选择**：点 Upload → 系统文件选择器 → 选择 `/sdcard/Download/chatdemo-test.zip`
  → 页面弹出 “Import chat history?” 确认框，说明文件已成功传回网页
- **麦克风**：弹出系统 “Allow Chat Demo to record audio?” 授权框；授权后
  `getUserMedia` 返回 1 个音频轨（CDP 断言 `granted:1`）
- **边到边适配**：WebView 视口为 1080×2211、起点 y=63，正好扣掉状态栏 63px
  和导航栏 126px

截图见 `screenshots/`：`main_ui.png`、`file_picker.png`、`import_confirm.png`、
`mic_permission.png`。

> 页面本身要求有效 API Key 才会进入语音输入流程，验证时是通过 WebView 远程调试
> 直接调用 `getUserMedia` 完成的。debug 构建已启用 WebView 调试（`chrome://inspect`），
> release 构建不会启用。

## 其它

- 只声明了 `INTERNET` 权限，用于网页自身调用 DeepSeek API；应用启动时不联网。
- 关闭了 `usesCleartextTraffic`，只允许 https 请求。
- `assets/LICENSE` 是原站点附带的许可证文件，一并打包。
