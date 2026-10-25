plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The app's version is its own, not Boite's: the server it installs updates
// itself. `-PboiteVersion=` is MAJOR.MINOR.PATCH and `-PboiteVersionCode=` the
// integer Android compares on update, MAJOR*1000000 + MINOR*1000 + PATCH.
// Without them, a local build takes ../VERSION (MAJOR.MINOR) with patch 0.
val baseVersion = rootDir.resolve("VERSION").readText().trim()
val baseMatch = Regex("^([1-9][0-9]{0,2})\\.([0-9]{1,3})$").matchEntire(baseVersion)
    ?: throw GradleException("apps/android-server/VERSION must hold MAJOR.MINOR with MAJOR 1 to 999 and MINOR under 1000, got '$baseVersion'")
val appVersionName = (findProperty("boiteVersion") ?: "$baseVersion.0").toString()
if (!Regex("^[0-9]+\\.[0-9]+\\.[0-9]+$").matches(appVersionName)) {
    throw GradleException("-PboiteVersion must be MAJOR.MINOR.PATCH, got '$appVersionName'")
}
val appVersionCode = (findProperty("boiteVersionCode")
    ?: (baseMatch.groupValues[1].toInt() * 1_000_000 + baseMatch.groupValues[2].toInt() * 1_000)).toString()
if (!Regex("^[1-9][0-9]{0,8}$").matches(appVersionCode)) {
    throw GradleException("-PboiteVersionCode must be a positive integer under 10^9, got '$appVersionCode'")
}

android {
    namespace = "com.boite.server"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.boite.server"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode.toInt()
        versionName = appVersionName
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    val compose = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(compose)
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    // Draws the pairing link as a QR code.
    implementation("com.google.zxing:core:3.5.4")
}
