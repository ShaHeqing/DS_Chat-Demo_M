# Chat Demo WebView 套壳

把 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 构建出的静态站点
原样打包进 APK，用系统 WebView 打开。
**页面和所有静态资源都来自 APK 内部的 assets，不加载任何远程页面。**

## 下载 APK

- 发布页：<https://github.com/ShaHeqing/DS_Chat-Demo_M/releases/latest>
- 在 Release 的 **Assets** 里下载 `ChatDemo-vX.Y.Z.apk`
- 仓库已公开，可直接下载，无需登录 GitHub
- APK 使用 debug 签名，仅供测试安装（安装时需允许「未知来源」）

## 结构

```
app/src/main/
├── AndroidManifest.xml
├── java/com/example/chatdemo/MainActivity.java   # 唯一的 Java 文件
├── res/                                          # 主题、字符串、启动图标
│   └── raw/sidebar_swipe.js                      # 注入的侧边栏滑动手势
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

> 构建需要 JDK 17。如果默认 `java` 版本不是 17，请先设置：
> `set JAVA_HOME=<JDK 17 安装目录>`

```bat
gradlew.bat assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

用 Android Studio 打开本目录也可以直接构建运行；如果没有 `local.properties`，
Studio 会自动生成。

## 更新网页内容

网页产物来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)。
更新时先在该仓库构建（Node.js 22.12+，pnpm）：

```bash
pnpm install
pnpm build
```

然后把 `dist/` 里的内容复制进 `app/src/main/assets`（保留目录结构，
`index.html` 放在 assets 根目录）：

```bat
robocopy "<dist 目录>" "app\src\main\assets" /MIR
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

## 侧边栏滑动手势

侧边栏的打开/收起支持手势，过程中抽屉跟随手指移动：

- **关闭状态**：在页面内容区任意位置向右滑，侧边栏实时跟随手指展开
  （输入框、横向可滚动区域、弹窗内除外，长按选择文字不会触发）；
- **打开状态**：在侧边栏或其遮罩上向左滑，实时跟随手指收起；
- 松手后按「位置 + 速度」用临界阻尼弹簧吸附到目标，动画可以随时被打断：
  动画途中再次触摸会立刻停在当前位置，可以直接反方向继续拖；
- 打开/关闭按钮和遮罩点击播放同一套动画，并在 `touchend` 立即响应，
  绕过 WebView 约 300ms 的合成点击延迟；
- 普通点击、纵向滚动和侧边栏按钮不受影响。

网页包保持原样。壳层在页面加载完成后注入 `app/src/main/res/raw/sidebar_swipe.js`，
脚本只在运行时驱动抽屉的 `transform`，所以网页升级后手势仍然可用。

系统手势导航下，Android 会占用左右边缘约 30dp 作为返回手势区；不需要贴边，
从页面内侧正常右滑即可。壳层另外在屏幕垂直居中的 200dp 高度内申请了左侧
手势排除区（系统上限），这段区域也可以从最左缘直接滑出。返回手势仍可从
右缘、导航栏或返回键使用。

## 当前实现的边界

- 只支持文件与麦克风；摄像头/视频采集会被拒绝（`RESOURCE_VIDEO_CAPTURE`）。
- 麦克风被永久拒绝后不会弹自定义引导，页面会收到 `NotAllowedError`。
- **外部链接**：非本地域名的 http/https 链接会用系统浏览器打开。
- **返回键**：侧边栏打开时先带动画收起；否则 WebView 可后退时优先后退，
  再否则退出应用。
- **侧边栏手势**：依赖网页的 `aria-label`（打开边栏 / Open sidebar）和抽屉
  DOM 结构；网页大改版后如果选择器失效，需要同步调整 `sidebar_swipe.js`。
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

## 模拟器验证结果（2026-11-27，侧边栏手势）

AVD `chatdemo_test`（Android 15 / API 35）：

- 关闭状态在页面任意位置右滑都能拉出，抽屉位置严格跟随手指（+15 / +60 / +130px →
  −285 / −240 / −170px），松手后由弹簧平滑吸附到完全展开；
- 打开状态向左滑同样跟手，动画结束后由网页自身状态卸载抽屉；
- **动画打断**：展开动画途中再次触摸，抽屉停在该位置（例如 −40 → −27），
  可以直接反向拖到 −137 并松手关闭；收回动画途中反向右拖，也能从 −271 拉回
  −141 并重新展开；
- **快速连续操作**：开 → 关 → 开 连续三划后状态正确；关闭动画刚结束立即再滑，
  也能马上重新拉出；
- **按钮/遮罩点击**：在 `touchend` 立即响应，约 60ms 时已经滑到 −97 / −162，
  约 200ms 完成，不再等 WebView 的合成点击延迟；
- 短距离慢滑回弹，快速短滑按速度展开；纵向滚动和按钮点击不受影响；
- 设置弹窗内、输入框内、长按选字后拖动都不会误触发打开手势；
- 手势导航模式：居中 200dp 区域可从最左缘滑出，右缘返回仍可用；侧边栏
  打开时按返回会带动画收起；从边缘内侧约 30dp 起滑在全高度可用。

## 发布新版本

1. 按上一节更新 `app/src/main/assets`。
2. 递增 `app/build.gradle.kts` 中的 `versionCode`（Android 靠它识别升级），
   并按需修改 `versionName`。
3. 构建：

   ```bat
   set JAVA_HOME=<JDK 17 安装目录>
   gradlew.bat assembleDebug
   ```

4. 提交并推送源码：

   ```bat
   git add -A
   git commit -m "Release v1.0.1"
   git push
   ```

5. 创建 Release 并上传 APK：

   ```bat
   gh release create v1.0.1 app\build\outputs\apk\debug\app-debug.apk --title "v1.0.1" --notes "更新说明"
   ```

> 需要本机已安装 Git 和 GitHub CLI（`gh`），并已执行 `gh auth login`。

## 来源与许可

- Web 前端：[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，MIT License
- 当前内置的网页版本可通过 `app/src/main/assets/index.html` 中的
  `application-version` 查看
- 原始许可文件随网页产物一起打包在 `app/src/main/assets/LICENSE`
- 本仓库仅提供 Android WebView 包装层，属于第三方封装，并非 DeepSeek 官方发布

## 其它

- 只声明了 `INTERNET` 权限，用于网页自身调用 DeepSeek API；应用启动时不联网。
- 关闭了 `usesCleartextTraffic`，只允许 https 请求。
- `assets/LICENSE` 是原站点附带的许可证文件，一并打包。
