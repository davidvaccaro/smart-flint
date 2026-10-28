package org.smartflint.example

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.net.Uri
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors

/** Small system-browser sample. Configure the constants and copy both Kotlin files into an API26+ app. */
class SMARTFlintLaunchActivity : Activity() {
    private val client = SMARTFlintClient("https://flint.example.com")
    private val installationId = "replace-with-your-installation-id"
    private val registeredCallback = "org.smartflint.sample://callback"
    private val executor = Executors.newSingleThreadExecutor()
    private var session: SMARTFlintClient.Session? = null
    private lateinit var status: TextView
    private lateinit var connect: Button
    private lateinit var disconnect: Button
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { text = "Connect your record using SMART Flint." }
        connect = Button(this).apply { text = "Connect record"; setOnClickListener { begin() } }
        disconnect = Button(this).apply { text = "Disconnect"; isEnabled = false; setOnClickListener { endSession() } }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            addView(status); addView(connect); addView(disconnect)
        })
        handleCallback(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleCallback(intent) }

    private fun begin(incoming: Uri? = null) {
        if (busy || (session != null && incoming == null)) return
        val previous = if (incoming == null) null else session
        if (incoming != null) { session = null; status.text = "Connecting the record from this EHR launch…" }
        updateBusy(true)
        executor.execute {
            try {
                // Stop rendering the previous patient's activation before a new EHR launch.
                previous?.let { try { client.close(it) } catch (_: Exception) { /* The old local context stays cleared. */ } }
                client.cancelPendingLaunches()
                val launch = if (incoming == null) client.start(installationId, registeredCallback)
                    else client.resumeEHRLaunch(incoming, registeredCallback)
                runOnUiThread {
                    try {
                        // ACTION_VIEW selects an external browser; no WebView or embedded credentials.
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(launch.launchUrl)).addCategory(Intent.CATEGORY_BROWSABLE))
                        status.text = "Finish sign-in in your browser. Return here to cancel and start again."
                    } catch (_: Exception) { client.cancelPendingLaunches(); status.text = "The authorization browser could not open." }
                    updateBusy(false)
                }
            } catch (_: Exception) { showFailure() }
        }
    }

    private fun handleCallback(intent: Intent?) {
        val callback = intent?.data ?: return
        if (callback.scheme != "org.smartflint.sample" || callback.host != "callback") return
        if (callback.getQueryParameters("smart_flint_launch").isNotEmpty()) { begin(callback); return }
        if (busy || session != null) return
        updateBusy(true)
        executor.execute {
            try {
                val activated = client.completeRedirect(callback)
                // Ordinary FHIR libraries accept this endpoint and Authorization header.
                val connection = client.connection(activated)
                require(connection.first.startsWith("https://"))
                val patient = activated.activation.optJSONObject("context")?.optJSONObject("patient")?.optString("reference") ?: "Not supplied"
                runOnUiThread {
                    session = activated
                    status.text = "Record connected. Patient context: $patient. Your FHIR client can now use this activation."
                    updateBusy(false)
                }
            } catch (_: Exception) { showFailure() }
        }
    }

    private fun endSession() {
        val current = session ?: return
        updateBusy(true)
        executor.execute {
            try {
                client.close(current)
                runOnUiThread { session = null; status.text = "Disconnected."; updateBusy(false) }
            } catch (_: Exception) { showFailure() }
        }
    }

    private fun updateBusy(value: Boolean) { busy = value; connect.isEnabled = !value && session == null; disconnect.isEnabled = !value && session != null }
    private fun showFailure() { runOnUiThread { status.text = "This launch could not finish. Start a fresh launch; after app termination the previous transaction is intentionally unavailable."; updateBusy(false) } }

    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
}
