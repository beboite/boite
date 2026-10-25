package com.boite.server

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** Boite's dark palette: packages/ui/src/app.css, `--color-*` under :root. */
object Palette {
    val background = Color(0xFF101013)
    val surface = Color(0xFF151518)
    val surface2 = Color(0xFF1B1B1F)
    val surface3 = Color(0xFF232327)
    val foreground = Color(0xFFECECF1)
    val muted = Color(0xFFA2A2AD)
    val subtle = Color(0xFF8C8C96)
    // rgba(255, 255, 255, 0.07) and 0.14 over the background.
    val border = Color(0xFF212124)
    val edge = Color(0xFF353538)
    // oklch(68% 0.19 260), the default accent hue, in sRGB.
    val accent = Color(0xFF4C94FF)
    val accentInk = Color(0xFF101013)
    val success = Color(0xFF4ADE80)
    val live = Color(0xFFEAB308)
    val danger = Color(0xFFF0716F)
    val onDanger = Color(0xFFFFFFFF)
}

private val colors = darkColorScheme(
    primary = Palette.accent,
    onPrimary = Palette.accentInk,
    primaryContainer = Palette.surface3,
    onPrimaryContainer = Palette.foreground,
    secondary = Palette.muted,
    onSecondary = Palette.accentInk,
    secondaryContainer = Palette.surface3,
    onSecondaryContainer = Palette.foreground,
    background = Palette.background,
    onBackground = Palette.foreground,
    surface = Palette.background,
    onSurface = Palette.foreground,
    surfaceVariant = Palette.surface2,
    onSurfaceVariant = Palette.muted,
    surfaceContainerLowest = Palette.background,
    surfaceContainerLow = Palette.surface,
    surfaceContainer = Palette.surface,
    surfaceContainerHigh = Palette.surface2,
    surfaceContainerHighest = Palette.surface3,
    outline = Palette.edge,
    outlineVariant = Palette.border,
    error = Palette.danger,
    onError = Palette.onDanger,
)

// --radius-sm, -md, -lg and -xl.
private val shapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

@Composable
fun BoiteTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, shapes = shapes, content = content)
}
