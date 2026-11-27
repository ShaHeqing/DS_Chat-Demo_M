plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.chatdemo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.chatdemo"
        minSdk = 24
        targetSdk = 35
        versionCode = 5
        versionName = "1.1.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // WebViewAssetLoader: serves app assets over a virtual https:// origin
    implementation("androidx.webkit:webkit:1.12.1")
    // ViewCompat / WindowInsetsCompat for edge-to-edge layout on Android 15+
    implementation("androidx.core:core:1.13.1")
}
