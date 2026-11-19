plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "com.zelvior.zdm"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.zelvior.zdm"
        minSdk = 21 // old 32-bit devices; 64-bit build is produced in the same variants
        targetSdk = 34
        versionCode = 1
        versionName = "0.3.0"
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
    buildTypes { release { isMinifyEnabled = false } }
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a")
            isUniversalApk = true
        }
    }
}

android.sourceSets.getByName("main").assets.srcDirs("../../../renderer", "../../../assets", "../shared")

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
