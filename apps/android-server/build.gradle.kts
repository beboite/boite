plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP compiles Kotlin itself; naming the Kotlin plugin here only pins the
    // compiler, which the Compose compiler plugin must match.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
