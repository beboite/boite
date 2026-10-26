package com.boite.server

import android.graphics.Bitmap
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

@Composable
fun App(model: ServerModel, actions: MainActivity.Actions) {
    val snackbar = remember { SnackbarHostState() }
    val restartLabel = stringResource(R.string.restart)
    LaunchedEffect(model.notice) {
        val notice = model.notice ?: return@LaunchedEffect
        val result = snackbar.showSnackbar(
            notice.text,
            actionLabel = if (notice.restart) restartLabel else null,
            withDismissAction = true,
            // An error stays long enough to be read; a restart offer stays until answered.
            duration = when {
                notice.restart -> SnackbarDuration.Indefinite
                notice.error -> SnackbarDuration.Long
                else -> SnackbarDuration.Short
            },
        )
        if (result == SnackbarResult.ActionPerformed && notice.restart) model.restart()
        model.notice = null
    }
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.safeDrawingPadding()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.padding(horizontal = 4.dp, vertical = 4.dp)) {
                    Text(stringResource(R.string.app_name), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                    Text(stringResource(R.string.tagline), color = Palette.muted, fontSize = 13.sp)
                }
                when (val phase = model.phase) {
                    Phase.Checking -> Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    Phase.NoTermux -> NoTermux(actions)
                    Phase.NoPermission -> NoPermission(actions)
                    is Phase.Setup -> Setup(phase.reason, actions)
                    Phase.Ready -> Dashboard(model, actions)
                }
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(16.dp)) { data ->
                Snackbar(data, containerColor = Palette.surface3, contentColor = Palette.foreground, actionColor = Palette.accent)
            }
        }
    }
    model.pairing?.let { pairing -> PairingDialog(pairing, actions) { model.pairing = null } }
}

@Composable
private fun Section(title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Palette.surface, MaterialTheme.shapes.medium)
            .border(1.dp, Palette.border, MaterialTheme.shapes.medium)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (title != null) Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        content()
    }
}

@Composable
private fun Muted(text: String) = Text(text, color = Palette.muted, fontSize = 14.sp)

@Composable
private fun NoTermux(actions: MainActivity.Actions) = Section(stringResource(R.string.termux_title)) {
    Muted(stringResource(R.string.termux_body))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { actions.open("https://f-droid.org/packages/com.termux/") }) { Text(stringResource(R.string.termux_fdroid)) }
        OutlinedButton(onClick = { actions.open("https://github.com/termux/termux-app/releases/latest") }) { Text(stringResource(R.string.termux_github)) }
        TextButton(onClick = { actions.refresh() }) { Text(stringResource(R.string.check_again)) }
    }
}

@Composable
private fun NoPermission(actions: MainActivity.Actions) = Section(stringResource(R.string.permission_title)) {
    Muted(stringResource(R.string.permission_body))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { actions.askPermission() }) { Text(stringResource(R.string.permission_allow)) }
        // After two refusals Android stops asking: the permission is then in the app's settings.
        OutlinedButton(onClick = { actions.appSettings() }) { Text(stringResource(R.string.permission_settings)) }
    }
}

@Composable
private fun Setup(reason: String?, actions: MainActivity.Actions) = Section(stringResource(R.string.setup_title)) {
    var channel by remember { mutableStateOf("stable") }
    val command = Termux.installCommand(channel)
    Step(1, stringResource(R.string.setup_step_channel))
    Choice(listOf("stable" to stringResource(R.string.channel_stable), "nightly" to stringResource(R.string.channel_nightly)), channel) { channel = it }
    Step(2, stringResource(R.string.setup_step_paste))
    Code(command)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { actions.copy(command); actions.openTermux() }) { Text(stringResource(R.string.setup_open_termux)) }
        OutlinedButton(onClick = { actions.copy(command) }) { Text(stringResource(R.string.copy)) }
    }
    Step(3, stringResource(R.string.setup_step_wait))
    if (!reason.isNullOrBlank()) Text(stringResource(R.string.setup_termux_said, reason), color = Palette.subtle, fontSize = 12.sp)
    TextButton(onClick = { actions.refresh() }) { Text(stringResource(R.string.check_again)) }
}

@Composable
private fun Step(number: Int, text: String) = Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    Box(Modifier.size(22.dp).background(Palette.surface3, CircleShape), contentAlignment = Alignment.Center) {
        Text("$number", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
    Text(text, fontSize = 14.sp, modifier = Modifier.weight(1f))
}

@Composable
private fun Code(text: String) = Box(
    Modifier
        .fillMaxWidth()
        .background(Palette.background, MaterialTheme.shapes.small)
        .border(1.dp, Palette.border, MaterialTheme.shapes.small)
        .horizontalScroll(rememberScrollState())
        .padding(12.dp),
) {
    Text(text, fontFamily = FontFamily.Monospace, fontSize = 12.sp, softWrap = false)
}

@Composable
private fun Choice(options: List<Pair<String, String>>, selected: String, enabled: Boolean = true, onSelect: (String) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = value == selected,
                onClick = { if (value != selected) onSelect(value) },
                enabled = enabled,
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
                label = { Text(label, fontSize = 13.sp, maxLines = 1) },
            )
        }
    }
}

/** One option per line, for labels too long to sit side by side on a narrow phone. */
@Composable
private fun Options(options: List<Pair<String, String>>, selected: String, enabled: Boolean = true, onSelect: (String) -> Unit) {
    Column(Modifier.selectableGroup()) {
        options.forEach { (value, label) ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .selectable(selected = value == selected, enabled = enabled, role = Role.RadioButton) { if (value != selected) onSelect(value) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = value == selected, onClick = null, enabled = enabled)
                Text(label, fontSize = 14.sp, modifier = Modifier.padding(start = 12.dp))
            }
        }
    }
}

@Composable
private fun Dashboard(model: ServerModel, actions: MainActivity.Actions) {
    val status = model.status ?: return
    val busy = model.busy
    StatusSection(status, busy, model)
    // With no agent installed there is nothing to sign in: Updates offers Claude Code.
    if (status.running && status.healthy && (status.claude?.version != null || status.codex?.version != null)) SignInSection(status, busy, model)
    if (status.running) PairSection(busy, model)
    UpdatesSection(status, busy, model)
    SettingsSection(status, busy, model)
    AliveSection(actions)
    LogsSection(busy, model)
    RemoveSection(busy, model)
}

@Composable
private fun StatusSection(status: Status, busy: String?, model: ServerModel) = Section {
    // The uptime moves on between two statuses that read the same.
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(30_000)
            value = System.currentTimeMillis()
        }
    }
    val (label, color) = when {
        status.running && status.healthy -> R.string.state_running to Palette.success
        status.running -> R.string.state_starting to Palette.live
        else -> R.string.state_stopped to Palette.subtle
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Text(stringResource(label), fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        status.version?.let { Text(stringResource(R.string.version, it), color = Palette.muted, fontSize = 13.sp) }
    }
    val channel = stringResource(if (status.channel == "nightly") R.string.channel_nightly else R.string.channel_stable)
    val since = status.since?.takeIf { status.running }?.let { stringResource(R.string.up_for, duration(now - it)) }
    Muted(listOfNotNull(stringResource(R.string.channel_line, channel), since).joinToString(" · "))
    if (status.running) {
        if (status.urls.isEmpty() && status.host == "tailscale") {
            Muted(stringResource(R.string.waiting_tailscale))
        } else if (status.urls.isNotEmpty() && status.host != "local") {
            Text(stringResource(R.string.reach_at), fontSize = 13.sp, color = Palette.subtle)
            status.urls.forEach { url -> Text(url, fontFamily = FontFamily.Monospace, fontSize = 13.sp) }
        }
    }
    when (busy) {
        "start", "stop", "restart" -> {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Muted(stringResource(when (busy) { "start" -> R.string.busy_start; "stop" -> R.string.busy_stop; else -> R.string.busy_restart }))
        }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (status.running) {
            OutlinedButton(onClick = model::restart, enabled = busy == null) { Text(stringResource(R.string.restart)) }
            OutlinedButton(onClick = model::stop, enabled = busy == null) { Text(stringResource(R.string.stop)) }
        } else {
            Button(onClick = model::start, enabled = busy == null) { Text(stringResource(R.string.start)) }
        }
    }
}

@Composable
private fun PairSection(busy: String?, model: ServerModel) = Section(stringResource(R.string.pair_title)) {
    PairRow(stringResource(R.string.pair_device), stringResource(R.string.pair_device_hint), busy) { model.pair(owner = false) }
    HorizontalDivider(color = Palette.border)
    PairRow(stringResource(R.string.pair_owner), stringResource(R.string.pair_owner_hint), busy) { model.pair(owner = true) }
}

@Composable
private fun PairRow(title: String, hint: String, busy: String?, onClick: () -> Unit) =
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(hint, color = Palette.muted, fontSize = 13.sp)
        }
        OutlinedButton(onClick = onClick, enabled = busy == null) { Text(stringResource(R.string.pair_show)) }
    }

@Composable
private fun PairingDialog(pairing: Pairing, actions: MainActivity.Actions, onDismiss: () -> Unit) {
    DisposableEffect(Unit) {
        actions.secure(true)
        onDispose { actions.secure(false) }
    }
    var index by remember(pairing) { mutableStateOf(0) }
    val url = pairing.urls[index.coerceIn(pairing.urls.indices)]
    val code = remember(url) { qr(url) }
    val context = LocalContext.current
    val until = remember(pairing.expiresAt) { pairing.expiresAt?.let { time(it, context) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.surface2,
        title = { Text(stringResource(if (pairing.owner) R.string.pair_dialog_owner else R.string.pair_dialog_device)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Muted(listOfNotNull(stringResource(R.string.pair_dialog_body), until?.let { stringResource(R.string.pair_until, it) }).joinToString(" "))
                if (pairing.urls.size > 1) {
                    Choice(pairing.urls.mapIndexed { i, link -> "$i" to addressLabel(link) }, "$index") { index = it.toInt() }
                }
                Image(
                    code,
                    contentDescription = url.substringBefore('?'),
                    filterQuality = FilterQuality.None,
                    modifier = Modifier.size(240.dp),
                )
                Text(url.substringBefore('?'), fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Palette.muted)
                Text(stringResource(R.string.pair_secret), fontSize = 12.sp, color = Palette.subtle)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) } },
        dismissButton = { TextButton(onClick = { actions.copy(url, sensitive = true) }) { Text(stringResource(R.string.pair_copy)) } },
    )
}

@Composable
private fun addressLabel(url: String): String {
    val host = url.substringAfter("://").substringBefore(':')
    val parts = host.split('.').mapNotNull { it.toIntOrNull() }
    // Tailscale's addresses: 100.64.0.0/10.
    val tailnet = parts.size == 4 && parts[0] == 100 && parts[1] in 64..127
    return stringResource(if (tailnet) R.string.tailscale_address else R.string.wifi_address)
}

@Composable
private fun UpdatesSection(status: Status, busy: String?, model: ServerModel) = Section(stringResource(R.string.updates_title)) {
    val available = model.available
    if (available != null) {
        Text(stringResource(R.string.available, available), fontSize = 14.sp)
        Button(onClick = model::update, enabled = busy == null) { Text(stringResource(R.string.update_now)) }
    } else {
        OutlinedButton(onClick = model::checkUpdate, enabled = busy == null) { Text(stringResource(R.string.check_updates)) }
    }
    if (busy == "check" || busy == "update") {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        if (busy == "update") Muted(stringResource(R.string.updating))
    }
    HorizontalDivider(color = Palette.border)
    AgentRow(stringResource(R.string.claude), status.claude)
    if (busy == "claude") {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        Muted(stringResource(R.string.updating_claude))
    }
    OutlinedButton(onClick = model::updateClaude, enabled = busy == null) { Text(stringResource(R.string.update_claude)) }
    AgentRow(stringResource(R.string.codex), status.codex)
    Text(stringResource(R.string.codex_hint), color = Palette.subtle, fontSize = 12.sp)
}

/** Whether the agents can answer: a conversation with no signed-in account gets nothing back. */
@Composable
private fun SignInSection(status: Status, busy: String?, model: ServerModel) = Section(stringResource(R.string.sign_in_title)) {
    // Not knowing the accounts still leaves each agent's Sign in to try.
    val signIns = status.signIns
    if (signIns == null) Muted(stringResource(R.string.sign_in_unknown))
    else if (status.nobodySignedIn) {
        Text(stringResource(R.string.nobody_signed_in), fontSize = 14.sp, fontWeight = FontWeight.Medium)
        Muted(stringResource(R.string.sign_in_hint))
    }
    listOf(Triple("claude", R.string.claude, status.claude), Triple("codex", R.string.codex, status.codex))
        .filter { (_, _, agent) -> agent?.version != null }
        .forEach { (id, name, _) ->
            val state = signIns?.get(id)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(name), fontSize = 14.sp)
                    if (signIns != null) Text(
                        stringResource(when (state) {
                            "ok" -> R.string.signed_in
                            "unknown" -> R.string.sign_in_checking
                            "error" -> R.string.sign_in_error
                            else -> R.string.signed_out
                        }),
                        color = if (state == "ok") Palette.success else Palette.muted,
                        fontSize = 13.sp,
                    )
                }
                if (state != "ok") OutlinedButton(onClick = { model.signIn(id) }, enabled = busy == null) { Text(stringResource(R.string.sign_in)) }
            }
        }
}

@Composable
private fun AgentRow(name: String, agent: Agent?) = Row {
    Text(name, fontSize = 14.sp, modifier = Modifier.weight(1f))
    Text(
        when {
            agent == null -> stringResource(R.string.not_checked)
            agent.version == null -> stringResource(R.string.not_installed)
            else -> agent.version
        },
        color = Palette.muted,
        fontSize = 14.sp,
    )
}

@Composable
private fun SettingsSection(status: Status, busy: String?, model: ServerModel) = Section(stringResource(R.string.settings_title)) {
    val idle = busy == null
    Label(stringResource(R.string.setting_channel))
    Choice(listOf("stable" to stringResource(R.string.channel_stable), "nightly" to stringResource(R.string.channel_nightly)), status.channel, idle) {
        model.set("channel", it)
    }
    Label(stringResource(R.string.setting_host))
    Options(
        listOf("lan" to stringResource(R.string.host_lan), "tailscale" to stringResource(R.string.host_tailscale), "local" to stringResource(R.string.host_local)),
        status.host,
        idle,
    ) { model.set("host", it) }
    Label(stringResource(R.string.setting_port))
    var port by remember(status.port) { mutableStateOf("${status.port}") }
    val valid = port.toIntOrNull()?.let { it in 1024..65535 } == true
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = port,
            onValueChange = { port = it.filter(Char::isDigit).take(5) },
            singleLine = true,
            isError = !valid,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            supportingText = if (valid) null else ({ Text(stringResource(R.string.setting_port_invalid)) }),
            modifier = Modifier.widthIn(max = 160.dp),
        )
        OutlinedButton(onClick = { model.set("port", port) }, enabled = idle && valid && port != "${status.port}") { Text(stringResource(R.string.save)) }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.setting_autostart), fontSize = 14.sp, modifier = Modifier.weight(1f))
        Switch(checked = status.autostart, onCheckedChange = { model.set("autostart", if (it) "on" else "off") }, enabled = idle)
    }
}

@Composable
private fun Label(text: String) = Text(text, fontSize = 13.sp, color = Palette.subtle)

@Composable
private fun AliveSection(actions: MainActivity.Actions) = Section(stringResource(R.string.alive_title)) {
    Muted(stringResource(R.string.alive_body))
    Bullet(stringResource(R.string.alive_battery))
    Bullet(stringResource(R.string.alive_autostart))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Bullet(stringResource(R.string.alive_children))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { actions.appSettings(Termux.PACKAGE) }) { Text(stringResource(R.string.alive_termux_settings)) }
        OutlinedButton(onClick = { actions.appSettings() }) { Text(stringResource(R.string.alive_app_settings)) }
        val maker = Build.MANUFACTURER.replaceFirstChar { it.titlecase(Locale.ROOT) }
        TextButton(onClick = { actions.open(guide()) }) { Text(stringResource(R.string.alive_guide, maker)) }
    }
}

/** dontkillmyapp.com keeps one page per phone maker, with the settings each one hides. */
private fun guide(): String {
    val maker = Build.MANUFACTURER.lowercase(Locale.ROOT).filter { it.isLetterOrDigit() }
    return if (maker.isEmpty()) "https://dontkillmyapp.com/" else "https://dontkillmyapp.com/$maker"
}

@Composable
private fun Bullet(text: String) = Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    Text("•", color = Palette.subtle, fontSize = 14.sp)
    Text(text, fontSize = 14.sp, modifier = Modifier.weight(1f))
}

@Composable
private fun LogsSection(busy: String?, model: ServerModel) = Section(stringResource(R.string.logs_title)) {
    val logs = model.logs
    if (logs != null) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(280.dp)
                .background(Palette.background, MaterialTheme.shapes.small)
                .border(1.dp, Palette.border, MaterialTheme.shapes.small),
        ) {
            val scroll = rememberScrollState()
            LaunchedEffect(logs) { scroll.scrollTo(scroll.maxValue) }
            Text(
                if (logs.isEmpty()) stringResource(R.string.logs_empty) else logs.joinToString("\n"),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                lineHeight = 15.sp,
                color = Palette.muted,
                modifier = Modifier.fillMaxSize().verticalScroll(scroll).horizontalScroll(rememberScrollState()).padding(10.dp),
                softWrap = false,
            )
        }
    }
    OutlinedButton(onClick = model::loadLogs, enabled = busy == null) {
        Text(stringResource(if (logs == null) R.string.logs_show else R.string.logs_refresh))
    }
}

@Composable
private fun RemoveSection(busy: String?, model: ServerModel) = Section(stringResource(R.string.remove_title)) {
    var asking by remember { mutableStateOf(false) }
    var purge by remember { mutableStateOf(false) }
    Muted(stringResource(R.string.remove_body))
    if (busy == "uninstall") LinearProgressIndicator(Modifier.fillMaxWidth())
    OutlinedButton(onClick = { asking = true }, enabled = busy == null) { Text(stringResource(R.string.remove_button), color = Palette.danger) }
    if (asking) {
        AlertDialog(
            onDismissRequest = { asking = false },
            containerColor = Palette.surface2,
            title = { Text(stringResource(R.string.remove_confirm)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Muted(stringResource(R.string.remove_body))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = purge, onCheckedChange = { purge = it })
                        Text(stringResource(R.string.remove_purge), fontSize = 14.sp)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { asking = false; model.uninstall(purge) }) { Text(stringResource(R.string.remove_button), color = Palette.danger) }
            },
            dismissButton = { TextButton(onClick = { asking = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun duration(ms: Long): String {
    val minutes = (ms / 60_000).coerceAtLeast(0)
    return when {
        minutes >= 24 * 60 -> stringResource(R.string.duration_days, (minutes / (24 * 60)).toInt(), ((minutes / 60) % 24).toInt())
        minutes >= 60 -> stringResource(R.string.duration_hours, (minutes / 60).toInt(), (minutes % 60).toInt())
        else -> stringResource(R.string.duration_minutes, minutes.toInt())
    }
}

/** The core's ISO time, in the phone's own clock format. */
private fun time(iso: String, context: android.content.Context): String? = runCatching {
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
    android.text.format.DateFormat.getTimeFormat(context).format(parser.parse(iso)!!)
}.getOrNull()

/** Black modules on white with a quiet zone, whatever the theme: scanners expect it. */
private fun qr(text: String): androidx.compose.ui.graphics.ImageBitmap {
    val hints = mapOf(EncodeHintType.MARGIN to 2, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M)
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
    val pixels = IntArray(matrix.width * matrix.height) { index ->
        if (matrix.get(index % matrix.width, index / matrix.width)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
    return Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.ARGB_8888).asImageBitmap()
}
