package com.example.chatdemo;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Minimal WebView shell.
 *
 * The whole web app lives in app/src/main/assets and is served through
 * WebViewAssetLoader on the virtual origin https://appassets.androidplatform.net/,
 * so nothing is loaded from a remote server. A real https origin (instead of
 * file:///android_asset/...) keeps localStorage, fetch/XHR and CORS working the
 * same way they do in a browser.
 *
 * Also bridges the browser features the page relies on:
 *   - <input type="file">      -> system file picker (single and multiple)
 *   - getUserMedia({audio})    -> runtime RECORD_AUDIO permission + WebView grant
 *   - sidebar edge swipe       -> injected JS (res/raw/sidebar_swipe.js)
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/index.html";

    private static final int REQUEST_CHOOSE_FILE = 1001;
    private static final int REQUEST_MIC_PERMISSION = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private PermissionRequest pendingMicRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Chrome DevTools support for debug builds only (chrome://inspect).
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Maps "/" to the root of app/src/main/assets.
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        // Files returned by the system picker are content:// URIs; WebView needs
        // content access enabled to read them when the page uploads a file.
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebChromeClient(new ChatChromeClient());

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
                if (response != null) {
                    return response;
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (ASSET_HOST.equals(uri.getHost())) {
                    return false;
                }
                openInBrowser(uri);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith("https://" + ASSET_HOST + "/")) {
                    injectSidebarSwipe(view);
                }
            }
        });

        // On Android 15+ (targetSdk 35) the window is edge-to-edge. Padding the
        // WebView itself does not shrink the page viewport, so the WebView lives
        // inside a container that takes the insets instead.
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.WHITE);
        container.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        ViewCompat.setOnApplyWindowInsetsListener(container, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            view.post(() -> reserveEdgeForSidebarSwipe(view, windowInsets));
            return windowInsets;
        });

        setContentView(container);
        webView.loadUrl(START_URL);
    }

    /**
     * Under gesture navigation the system claims the first ~30dp of each screen
     * edge for its back gesture, so a swipe starting on the very edge never
     * reaches the WebView. Exclude a narrow strip on the left so the sidebar
     * gesture can start at the edge; back is still available from the right
     * edge, the navigation bar and the hardware key.
     *
     * The platform only honors 200dp of vertical extent, so the strip is
     * centered vertically. Outside that band the gesture can still start just
     * inside the edge, outside the system's back-gesture area.
     */
    private void reserveEdgeForSidebarSwipe(View view, WindowInsetsCompat windowInsets) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return;
        }
        int gestureInset = windowInsets.getInsets(WindowInsetsCompat.Type.systemGestures()).left;
        if (gestureInset <= 0 || view.getHeight() <= 0) {
            view.setSystemGestureExclusionRects(Collections.emptyList());
            return;
        }
        float density = getResources().getDisplayMetrics().density;
        int width = Math.min(
                gestureInset + Math.round(4 * density),
                Math.round(48 * density));
        // The platform caps gesture exclusions at 200dp of vertical extent.
        int maxHeight = Math.round(200 * density);
        int top = Math.max(0, (view.getHeight() - maxHeight) / 2);
        int bottom = Math.min(view.getHeight(), top + maxHeight);
        view.setSystemGestureExclusionRects(Collections.singletonList(
                new Rect(0, top, width, bottom)));
    }

    /**
     * The web bundle is prebuilt and its sidebar is mounted lazily without any
     * transition, so the swipe gesture is injected on top of it instead of
     * modifying the bundle. The script is idempotent and safe to inject again.
     */
    private void injectSidebarSwipe(WebView view) {
        try (InputStream in = getResources().openRawResource(R.raw.sidebar_swipe)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            String script = new String(out.toByteArray(), StandardCharsets.UTF_8);
            view.evaluateJavascript(script, null);
        } catch (IOException e) {
            // Progressive enhancement: the page still works without the gesture.
        }
    }

    /**
     * Bridges the browser APIs the web app uses to Android.
     */
    private final class ChatChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            // A previous chooser must always be answered before starting a new one.
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
            }
            pendingFileCallback = callback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            applyAcceptTypes(intent, params.getAcceptTypes());

            try {
                startActivityForResult(
                        Intent.createChooser(intent, getString(R.string.choose_file)),
                        REQUEST_CHOOSE_FILE);
            } catch (ActivityNotFoundException e) {
                pendingFileCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
            return true;
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> handlePermissionRequest(request));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMicRequest == request) {
                pendingMicRequest = null;
            }
        }
    }

    private void handlePermissionRequest(PermissionRequest request) {
        boolean requestsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                requestsAudio = true;
                break;
            }
        }
        if (!requestsAudio) {
            // Only microphone access is supported by this shell.
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            return;
        }

        if (pendingMicRequest != null) {
            pendingMicRequest.deny();
        }
        pendingMicRequest = request;
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC_PERMISSION);
    }

    /**
     * Android's document picker filters by MIME type, not by file extension.
     * If the page lists extensions (".zip", ...), show all files and let the
     * page validate them instead of risking a filtered-out pick.
     */
    private static void applyAcceptTypes(Intent intent, String[] acceptTypes) {
        if (acceptTypes == null) {
            intent.setType("*/*");
            return;
        }

        List<String> mimeTypes = new ArrayList<>();
        boolean hasExtension = false;
        for (String raw : acceptTypes) {
            if (raw == null) {
                continue;
            }
            String type = raw.trim();
            if (type.isEmpty()) {
                continue;
            }
            if (type.startsWith(".")) {
                hasExtension = true;
            } else if (type.contains("/")) {
                mimeTypes.add(type);
            }
        }

        if (hasExtension || mimeTypes.isEmpty()) {
            intent.setType("*/*");
            return;
        }
        intent.setType(mimeTypes.get(0));
        if (mimeTypes.size() > 1) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CHOOSE_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }

        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        if (callback == null) {
            return;
        }

        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clipData = data.getClipData();
            if (clipData != null && clipData.getItemCount() > 0) {
                result = new Uri[clipData.getItemCount()];
                for (int i = 0; i < clipData.getItemCount(); i++) {
                    result[i] = clipData.getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        callback.onReceiveValue(result);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode == REQUEST_MIC_PERMISSION) {
            PermissionRequest request = pendingMicRequest;
            pendingMicRequest = null;
            if (request != null) {
                if (grantResults.length > 0
                        && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                }
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void openInBrowser(Uri uri) {
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // No browser installed, stay in the app.
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        // Back closes an open sidebar (with the gesture animation) before it
        // navigates WebView history or leaves the app.
        webView.evaluateJavascript(
                "(function(){var s=window.__chatDemoSidebarSwipe;"
                        + "if(s&&s.isOpen()){s.close();return true;}return false;})()",
                value -> {
                    if (!"true".equals(value)) {
                        handleBackFallback();
                    }
                });
    }

    private void handleBackFallback() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
        if (pendingMicRequest != null) {
            pendingMicRequest.deny();
            pendingMicRequest = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
