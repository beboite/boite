package com.boite.server

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Termux's RUN_COMMAND service, the one way this app reaches boite-server.
 * Termux runs the command as its own user, in its own process tree, and
 * answers through a PendingIntent. It refuses until `allow-external-apps` is
 * true in ~/.termux/termux.properties, which install.sh sets.
 * https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent
 */
object Termux {
    const val PACKAGE = "com.termux"
    const val PERMISSION = "com.termux.permission.RUN_COMMAND"
    private const val FILES = "/data/data/com.termux/files"
    const val HOME = "$FILES/home"
    const val CONTROLLER = "$FILES/usr/bin/boite-server"

    /** Pasted once into Termux: it installs Termux's packages, Bun, Boite and Claude Code, then lets this app in. */
    fun installCommand(channel: String): String =
        "curl -fsSL https://raw.githubusercontent.com/mtsu-dev/boite/main/apps/android-server/termux/install.sh | bash -s -- --channel $channel"

    fun installed(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    fun permitted(context: Context): Boolean =
        context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    private fun intent(arguments: List<String>, label: String): Intent =
        Intent("com.termux.RUN_COMMAND")
            .setClassName(PACKAGE, "com.termux.app.RunCommandService")
            .putExtra("com.termux.RUN_COMMAND_PATH", CONTROLLER)
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arguments.toTypedArray())
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME)
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            .putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", label)

    // Termux's service puts itself in the foreground at once, as Android 8 requires of a service started this way.
    private fun send(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }

    /** Runs `boite-server <arguments> --json` and forgets it: the phone's start, when nothing waits for the answer. */
    fun fire(context: Context, vararg arguments: String) {
        send(context, intent(arguments.toList() + "--json", "boite-server ${arguments.joinToString(" ")}"))
    }

    /**
     * Runs `boite-server <arguments>` in a new Termux terminal, for a command
     * the person types into, and brings Termux forward. This app opens the
     * activity itself: Android lets an app on screen do so, where Termux's
     * service, in the background, would need the right to draw over apps.
     */
    fun terminal(context: Context, vararg arguments: String) {
        try {
            send(context, intent(arguments.toList(), "boite-server ${arguments.joinToString(" ")}").putExtra("com.termux.RUN_COMMAND_BACKGROUND", false))
            context.packageManager.getLaunchIntentForPackage(PACKAGE)?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        } catch (error: RuntimeException) {
            throw TermuxRefused(error.message ?: error.toString())
        }
    }

    private val ids = AtomicInteger((System.currentTimeMillis() % 1_000_000).toInt())
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<Bundle>>()

    internal fun answer(id: Int, result: Bundle) {
        pending.remove(id)?.complete(result)
    }

    /**
     * Runs `boite-server <arguments> --json` and returns its answer. Throws
     * [TermuxRefused] when Termux would not run it, [CommandFailed] when
     * boite-server reported an error.
     */
    suspend fun run(context: Context, vararg arguments: String, timeoutMs: Long = 60_000): JSONObject {
        val id = ids.incrementAndGet()
        val answer = CompletableDeferred<Bundle>()
        pending[id] = answer
        // Distinct data keeps one command's PendingIntent from replacing another's.
        val reply = Intent(context, CommandResultReceiver::class.java)
            .setData(Uri.parse("boite-server://result/$id"))
            .putExtra(CommandResultReceiver.ID, id)
        val flags = PendingIntent.FLAG_ONE_SHOT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val intent = intent(arguments.toList() + "--json", "boite-server ${arguments.firstOrNull() ?: ""}")
            .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", PendingIntent.getBroadcast(context, id, reply, flags))
        try {
            send(context, intent)
        } catch (error: RuntimeException) {
            pending.remove(id)
            throw TermuxRefused(error.message ?: error.toString())
        }
        val result = withTimeoutOrNull(timeoutMs) { answer.await() }
        if (result == null) {
            pending.remove(id)
            throw CommandFailed("boite-server ${arguments.firstOrNull()} gave no answer within ${timeoutMs / 1000} s")
        }
        return parse(result)
    }

    private fun parse(result: Bundle): JSONObject {
        // Termux's own error, before or instead of running the command: -1 is its success.
        val err = result.getInt("err", -1)
        if (err != -1) throw TermuxRefused(result.getString("errmsg")?.trim().orEmpty().ifEmpty { "Termux error $err" })
        val stdout = result.getString("stdout").orEmpty()
        val line = stdout.lineSequence().map { it.trim() }.lastOrNull { it.startsWith("{") }
        val json = line?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (json == null) {
            val stderr = result.getString("stderr").orEmpty().trim()
            val code = if (result.containsKey("exitCode")) result.getInt("exitCode") else null
            throw CommandFailed(stderr.lines().lastOrNull { it.isNotBlank() } ?: "boite-server exited with ${code ?: "no code"}")
        }
        if (!json.optBoolean("ok")) throw CommandFailed(json.optString("error", "boite-server failed"))
        return json
    }
}

/** Termux would not run boite-server: not set up, not allowed, or not installed yet. */
class TermuxRefused(message: String) : Exception(message)

/** boite-server ran and reported an error. */
class CommandFailed(message: String) : Exception(message)

class CommandResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(ID, -1)
        val result = intent.getBundleExtra("result") ?: return
        Termux.answer(id, result)
    }

    companion object {
        const val ID = "com.boite.server.COMMAND_ID"
    }
}
