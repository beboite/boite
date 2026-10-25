package com.boite.server

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Starts the server with the phone. `boite-server boot` reads the autostart
 * setting itself and returns at once; the supervisor it leaves waits for the
 * network, Tailscale included.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in ACTIONS) return
        if (!Termux.installed(context) || !Termux.permitted(context)) return
        runCatching { Termux.fire(context, "boot") }
    }

    private companion object {
        val ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
        )
    }
}
