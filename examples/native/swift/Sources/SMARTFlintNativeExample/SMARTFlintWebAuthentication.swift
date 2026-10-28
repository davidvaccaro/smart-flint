import AuthenticationServices
import Foundation

private final class WindowPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let window: ASPresentationAnchor
    init(window: ASPresentationAnchor) { self.window = window }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }
}

/// Retain one controller per sign-in UI. Uses the system authorization browser, never an embedded WebView.
@MainActor
public final class SMARTFlintWebAuthentication: NSObject {
    private var active: ASWebAuthenticationSession?
    private var presentation: WindowPresentationContext?
    private var starting = false

    public override init() { super.init() }

    public func signIn(client: SMARTFlintClient, installationID: String, callbackURL: URL,
                       presentationAnchor: ASPresentationAnchor, mode: String = "gateway",
                       incomingEHRLaunch: URL? = nil) async throws -> SMARTFlintClient.Session {
        guard !starting, active == nil, let scheme = callbackURL.scheme else {
            throw SMARTFlintClient.SMARTFlintError(code: "sign_in_in_progress", message: "Finish the current sign-in first.")
        }
        starting = true
        defer { starting = false }
        let launch: SMARTFlintClient.Launch
        if let incomingEHRLaunch {
            var incoming = URLComponents(url: incomingEHRLaunch, resolvingAgainstBaseURL: false)
            let items = (incoming?.queryItems ?? []).filter { $0.name != "smart_flint_launch" }
            incoming?.queryItems = items.isEmpty ? nil : items
            guard incoming?.url == callbackURL else {
                throw SMARTFlintClient.SMARTFlintError(code: "callback_mismatch", message: "The EHR launch did not target this app callback.")
            }
            launch = try await client.resumeEHRLaunch(incomingEHRLaunch, mode: mode)
        } else {
            launch = try await client.start(installationID: installationID, callbackURL: callbackURL, mode: mode)
        }
        do {
            try Task.checkCancellation()
            let callback: URL = try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    let browser = ASWebAuthenticationSession(url: launch.launchUrl, callbackURLScheme: scheme) { [weak self] url, error in
                        Task { @MainActor in
                            self?.active = nil
                            self?.presentation = nil
                            if let url { continuation.resume(returning: url) }
                            else { continuation.resume(throwing: error ?? SMARTFlintClient.SMARTFlintError(code: "authorization_cancelled", message: "Sign-in was cancelled. Start again when ready.")) }
                        }
                    }
                    let presentation = WindowPresentationContext(window: presentationAnchor)
                    browser.presentationContextProvider = presentation
                    // Let the EHR system browser apply its normal account/SSO policy.
                    self.presentation = presentation
                    self.active = browser
                    if !browser.start() {
                        self.active = nil
                        self.presentation = nil
                        continuation.resume(throwing: SMARTFlintClient.SMARTFlintError(code: "browser_unavailable", message: "The system authorization browser could not start."))
                    }
                }
            }, onCancel: { [self] in Task { @MainActor in self.cancel() } })
            return try await client.completeRedirect(callback)
        } catch {
            await client.cancelPendingLaunches()
            throw error
        }
    }

    public func cancel() { active?.cancel() }
}
