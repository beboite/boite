package com.boite.server

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * `boite-server status --json`. `claude` and `codex` are null when not checked;
 * `signIns` holds each provider's best account status, null when not known.
 */
data class Status(
    val installed: Boolean,
    val version: String?,
    val running: Boolean,
    val healthy: Boolean,
    val channel: String,
    val host: String,
    val port: Int,
    val autostart: Boolean,
    val urls: List<String>,
    val since: Long?,
    val claude: Agent?,
    val codex: Agent?,
    val signIns: Map<String, String>?,
) {
    /** True when the core answered and holds no signed-in account: a conversation would get no answer. */
    val nobodySignedIn: Boolean get() = signIns != null && "ok" !in signIns.values

    companion object {
        fun of(json: JSONObject, before: Status?): Status = Status(
            installed = json.optBoolean("installed"),
            version = json.stringOrNull("version"),
            running = json.optBoolean("running"),
            healthy = json.optBoolean("healthy"),
            channel = json.optString("channel", "stable"),
            host = json.optString("host", "lan"),
            port = json.optInt("port", 7337),
            autostart = json.optBoolean("autostart", true),
            urls = json.optJSONArray("urls")?.let { list -> List(list.length()) { list.getString(it) } }.orEmpty(),
            since = if (json.isNull("since")) null else json.optLong("since"),
            // A quick status leaves the agents out: the last known versions and sign-ins stay.
            claude = if (json.has("claude")) Agent(json.stringOrNull("claude")) else before?.claude,
            codex = if (json.has("codex")) Agent(json.stringOrNull("codex")) else before?.codex,
            signIns = when {
                !json.has("claude") -> before?.signIns
                else -> json.optJSONObject("signIns")?.let { all -> all.keys().asSequence().associateWith { all.getString(it) } }
            },
        )
    }
}

/** An agent's installed version, null when it is missing. */
data class Agent(val version: String?)

data class Pairing(val owner: Boolean, val urls: List<String>, val expiresAt: String?)

data class Notice(val text: String, val error: Boolean = false, val restart: Boolean = false)

sealed interface Phase {
    data object Checking : Phase
    data object NoTermux : Phase
    data object NoPermission : Phase
    /** Termux runs, boite-server does not answer yet: the install command has not run, or has not finished. */
    data class Setup(val reason: String?) : Phase
    data object Ready : Phase
}

/** Everything the screen shows, refreshed from boite-server while the screen is visible. */
class ServerModel(private val context: Context, private val scope: CoroutineScope) {
    var phase by mutableStateOf<Phase>(Phase.Checking)
        private set
    var status by mutableStateOf<Status?>(null)
        private set
    /** The action under way, by its label; the buttons wait for it. */
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<Notice?>(null)
    var available by mutableStateOf<String?>(null)
        private set
    var pairing by mutableStateOf<Pairing?>(null)
    var logs by mutableStateOf<List<String>?>(null)

    private var polling: Job? = null

    /** Polls while the screen is visible: a quick status every 5 s, the agents' versions on the first. */
    fun visible(shown: Boolean) {
        polling?.cancel()
        polling = if (!shown) null else scope.launch {
            refresh(full = true)
            while (isActive) {
                delay(5_000)
                if (busy == null) refresh(full = false)
            }
        }
    }

    suspend fun refresh(full: Boolean) {
        if (!Termux.installed(context)) return run { phase = Phase.NoTermux }
        if (!Termux.permitted(context)) return run { phase = Phase.NoPermission }
        try {
            val json = if (full) Termux.run(context, "status", timeoutMs = 90_000) else Termux.run(context, "status", "--quick")
            val next = Status.of(json, status)
            status = next
            phase = if (next.installed) Phase.Ready else Phase.Setup(null)
        } catch (error: TermuxRefused) {
            phase = Phase.Setup(error.message)
        } catch (error: CommandFailed) {
            if (phase == Phase.Ready) notice = Notice(error.message.orEmpty(), error = true) else phase = Phase.Setup(error.message)
        }
    }

    private fun act(label: String, timeoutMs: Long, vararg arguments: String, done: (JSONObject) -> Unit) {
        if (busy != null) return
        busy = label
        scope.launch {
            try {
                done(Termux.run(context, *arguments, timeoutMs = timeoutMs))
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                notice = Notice(error.message.orEmpty(), error = true)
            } finally {
                busy = null
            }
        }
    }

    private fun took(json: JSONObject) {
        status = Status.of(json, status)
    }

    // stop waits up to 75 s for a turn to end before it forces the core down.
    fun start() = act("start", 150_000, "start", done = ::took)
    fun stop() = act("stop", 150_000, "stop", done = ::took)
    fun restart() = act("restart", 240_000, "restart", done = ::took)

    fun checkUpdate() = act("check", 90_000, "update", "--check") { json ->
        available = json.stringOrNull("available")
        if (available == null) notice = Notice(context.getString(R.string.up_to_date, json.optString("version")))
    }

    fun update() = act("update", 30 * 60_000L, "update") { json ->
        available = null
        notice = Notice(context.getString(R.string.updated, json.optString("version")))
        scope.launch { refresh(full = true) }
    }

    fun updateClaude() = act("claude", 30 * 60_000L, "claude-update") { json ->
        val version = json.optString("claude")
        status = status?.copy(claude = Agent(version))
        notice = Notice(context.getString(if (json.optBoolean("changed")) R.string.claude_updated else R.string.claude_current, version))
    }

    fun set(key: String, value: String) = act("config", 60_000, "config", key, value) {
        scope.launch { refresh(full = false) }
        // The running core keeps listening where it started; the channel and autostart apply on their own.
        if (status?.running == true && key in setOf("host", "port")) notice = Notice(context.getString(R.string.restart_to_apply), restart = true)
    }

    fun pair(owner: Boolean) = act("pair", 60_000, *(if (owner) arrayOf("pair", "--owner") else arrayOf("pair"))) { json ->
        val urls = json.optJSONArray("urls")?.let { list -> List(list.length()) { list.getString(it) } }
            ?: listOf(json.getString("url"))
        pairing = Pairing(owner, urls, json.stringOrNull("expiresAt"))
    }

    /** The agent's sign-in, typed in a Termux terminal; coming back here reads the accounts again. */
    fun signIn(agent: String) {
        try {
            Termux.terminal(context, "sign-in", agent)
        } catch (error: TermuxRefused) {
            notice = Notice(error.message.orEmpty(), error = true)
        }
    }

    fun loadLogs() = act("logs", 60_000, "logs", "200") { json ->
        val lines = json.optJSONArray("lines")
        logs = if (lines == null) emptyList() else List(lines.length()) { redact(lines.getString(it)) }
    }

    fun uninstall(purge: Boolean) = act("uninstall", 150_000, *(if (purge) arrayOf("uninstall", "--purge") else arrayOf("uninstall"))) {
        // A reinstall starts from nothing: no offer, link, logs or message from the removed server.
        status = null
        phase = Phase.Setup(null)
        available = null
        pairing = null
        logs = null
        notice = null
    }
}

private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else optString(key)

/** A pairing link in a log is a credential: its grant never reaches the screen. */
fun redact(line: String): String = line.replace(Regex("([?&#](grant|token)=)[^&\\s]+"), "$1…")
