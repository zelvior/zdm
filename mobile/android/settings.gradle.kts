pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "zdm-mobile"
include(":app")
