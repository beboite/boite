package com.boite.server

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.provider.Settings
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var model: ServerModel

    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        lifecycleScope.launch { model.refresh(full = true) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        model = ServerModel(applicationContext, lifecycleScope)
        setContent {
            BoiteTheme {
                App(model, Actions(this))
            }
        }
    }

    override fun onResume() {
        super.onResume()
        model.visible(true)
    }

    override fun onPause() {
        model.visible(false)
        super.onPause()
    }

    /** What the screen asks of Android. */
    class Actions(private val activity: MainActivity) {
        fun askPermission() = activity.permission.launch(Termux.PERMISSION)

        fun refresh() = activity.lifecycleScope.launch { activity.model.refresh(full = true) }

        fun open(url: String) = start(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

        fun openTermux() {
            activity.packageManager.getLaunchIntentForPackage(Termux.PACKAGE)?.let(::start)
        }

        fun appSettings(packageName: String = activity.packageName) =
            start(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))

        /** A pairing link is marked sensitive, so the keyboard's clipboard preview hides it. */
        fun copy(text: String, sensitive: Boolean = false) {
            val clip = ClipData.newPlainText(activity.getString(R.string.app_name), text)
            if (sensitive) {
                clip.description.extras = PersistableBundle().apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                    else putBoolean("android.content.extra.IS_SENSITIVE", true)
                }
            }
            (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
            // Android 13 shows its own confirmation.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(activity, R.string.copied, Toast.LENGTH_SHORT).show()
        }

        /** Keeps a pairing code out of screenshots and the recent apps view while it shows. */
        fun secure(on: Boolean) {
            if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }

        private fun start(intent: Intent) {
            try {
                activity.startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                // No app for it on this phone: the button does nothing rather than crash.
            }
        }
    }
}
