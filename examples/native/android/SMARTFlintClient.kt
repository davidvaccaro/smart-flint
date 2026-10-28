package org.smartflint.example

import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** Android API adapter example (API 26+). Invoke network methods off the main thread. */
class SMARTFlintClient(private val baseUrl: String) {
    data class Launch(val launchUrl: String, val expiresAt: String, val applicationId: String)
    class Session(val activation: JSONObject, internal val token: String) {
        override fun toString() = "SMARTFlintSession(${activation.optString("id")}, credential=[redacted])"
    }
    private data class Transaction(val verifier: String, val callback: String, val applicationId: String, val expiresAt: Long)
    private val transactions = mutableMapOf<String, Transaction>()
    private val random = SecureRandom()

    init {
        val url = URL(baseUrl)
        require(url.protocol == "https" || (url.protocol == "http" && url.host in listOf("localhost", "127.0.0.1", "::1"))) { "Use HTTPS outside loopback." }
        require(url.userInfo == null && url.query == null && url.ref == null) { "Use a plain service base URL." }
    }

    /** Present launchUrl in a system browser/Custom Tab, then pass the verified App Link here. */
    @Synchronized
    fun start(installationId: String, redirectUri: String, mode: String = "gateway", launchTicket: String? = null): Launch {
        transactions.entries.removeAll { it.value.expiresAt <= System.currentTimeMillis() }
        require(transactions.size < 8) { "Finish or cancel an earlier native launch first." }
        val verifier = randomString()
        val state = randomString()
        val challenge = encode(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        val body = JSONObject().put("installationId", installationId).put("redirectUri", redirectUri).put("mode", mode).put("codeChallenge", challenge).put("state", state)
        launchTicket?.let { body.put("launchTicket", it) }
        val data = request("/api/launches", "POST", body)
        val launch = Launch(data.getString("launchUrl"), data.getString("expiresAt"), data.getString("applicationId"))
        transactions[state] = Transaction(verifier, redirectUri, launch.applicationId, java.time.Instant.parse(launch.expiresAt).toEpochMilli())
        return launch
    }

    @Synchronized
    fun resumeEHRLaunch(incoming: Uri, registeredCallback: String, mode: String = "gateway"): Launch {
        val tickets = incoming.getQueryParameters("smart_flint_launch")
        require(tickets.size == 1 && tickets[0].isNotEmpty()) { "Exactly one EHR launch ticket is required." }
        val clean = incoming.buildUpon().clearQuery()
        incoming.queryParameterNames.filter { it != "smart_flint_launch" }.forEach { name -> incoming.getQueryParameters(name).forEach { clean.appendQueryParameter(name, it) } }
        require(clean.build().toString() == registeredCallback) { "EHR launch callback mismatch." }
        val bootstrap = request("/api/launches/bootstrap/${Uri.encode(tickets[0])}")
        return start(bootstrap.getString("installationId"), registeredCallback, mode, tickets[0])
    }

    @Synchronized
    fun cancelPendingLaunches() { transactions.clear() }

    @Synchronized
    fun completeRedirect(callback: Uri): Session {
        val reserved = setOf("code", "state", "error", "error_description")
        require(reserved.all { callback.getQueryParameters(it).size <= 1 }) { "Ambiguous callback." }
        val state = callback.getQueryParameter("state") ?: error("Missing state.")
        val transaction = transactions[state] ?: error("No matching native launch transaction.")
        val clean = callback.buildUpon().clearQuery()
        callback.queryParameterNames.filter { it !in reserved }.forEach { name -> callback.getQueryParameters(name).forEach { clean.appendQueryParameter(name, it) } }
        require(clean.build().toString() == transaction.callback) { "Callback destination mismatch." }
        transactions.remove(state)
        require(transaction.expiresAt > System.currentTimeMillis()) { "Launch expired. Start again." }
        require(callback.getQueryParameter("error") == null) { "Authorization was declined." }
        val code = callback.getQueryParameter("code") ?: error("Missing activation code.")
        val result = request("/api/activations/redeem", "POST", JSONObject().put("code", code).put("codeVerifier", transaction.verifier).put("applicationId", transaction.applicationId).put("redirectUri", transaction.callback))
        return Session(result.getJSONObject("activation"), result.getString("sessionToken"))
    }

    /** Pass this base URL and Authorization value to any HTTP or FHIR client. */
    fun connection(session: Session, direct: Boolean = false): Pair<String, String> {
        if (!direct) return Pair(session.activation.getJSONObject("gateway").getString("baseUrl"), "Bearer ${session.token}")
        val credential = request("/api/activations/${session.activation.getString("id")}/credentials", token = session.token)
        return Pair(credential.getString("baseUrl"), "${credential.getString("tokenType")} ${credential.getString("accessToken")}")
    }

    /** Sensitive JSON. Never place the result in logs, analytics, notifications, or URL parameters. */
    fun originalTokenResponse(session: Session): JSONObject = request("/api/activations/${session.activation.getString("id")}/credentials/original", token = session.token)

    fun handoff(session: Session): JSONObject = request("/api/activations/${session.activation.getString("id")}/credentials/handoff", "POST", token = session.token)

    fun close(session: Session) { request("/api/activations/${session.activation.getString("id")}", "DELETE", token = session.token) }

    private fun request(path: String, method: String = "GET", body: JSONObject? = null, token: String? = null): JSONObject {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val problem = runCatching { JSONObject(text) }.getOrNull()
                error(problem?.optString("message")?.takeIf { it.isNotBlank() } ?: "SMART Flint request failed ($status).")
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally { connection.disconnect() }
    }

    private fun randomString(): String = ByteArray(32).also { random.nextBytes(it) }.let(::encode)
    private fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
