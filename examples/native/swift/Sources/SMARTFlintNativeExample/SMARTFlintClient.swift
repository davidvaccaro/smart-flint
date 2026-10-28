import Foundation
import CryptoKit
import Security

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// A thin native API adapter example. The app owns browser presentation and secure storage policy.
public actor SMARTFlintClient {
    public struct Launch: Decodable, Sendable {
        public let launchUrl: URL
        public let expiresAt: String
        public let applicationId: String
    }
    public struct ResourceReference: Decodable, Sendable { public let reference: String }
    public struct Context: Decodable, Sendable {
        public let patient: ResourceReference?
        public let encounter: ResourceReference?
    }
    public struct Upstream: Decodable, Sendable {
        public let baseUrl: URL
        public let fhirVersion: String
    }
    public struct Gateway: Decodable, Sendable { public let baseUrl: URL }
    public struct Activation: Decodable, Sendable {
        public let id: String
        public let mode: String
        public let status: String
        public let context: Context
        public let upstream: Upstream
        public let gateway: Gateway
        public let refreshOwner: String
        public let tokenExportAllowed: Bool
    }
    public struct Session: Decodable, Sendable, CustomStringConvertible {
        public let activation: Activation
        public let sessionToken: String
        public var description: String { "SMART Flint session(\(activation.id), credential: [redacted])" }
    }
    public struct Credential: Decodable, Sendable, CustomStringConvertible {
        public let baseUrl: URL
        public let accessToken: String
        public let tokenType: String
        public let expiresAt: String?
        public let grantedScopes: [String]
        public let refreshOwner: String
        public let refreshToken: String?
        public let tokenEndpoint: URL?
        public let clientId: String?
        public var description: String { "SMART Flint credential(baseUrl: \(baseUrl), token: [redacted])" }
    }
    public struct SMARTFlintError: Error, Decodable, Sendable {
        public let code: String
        public let message: String
    }
    private struct Transaction {
        let verifier: String
        let callback: URL
        let applicationId: String
        let expiresAt: Date
    }

    private let baseURL: URL
    private let session: URLSession
    private var transactions: [String: Transaction] = [:]

    public init(baseURL: URL, session: URLSession? = nil) throws {
        guard baseURL.scheme == "https" || (baseURL.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(baseURL.host ?? "")),
              baseURL.user == nil, baseURL.password == nil, baseURL.query == nil, baseURL.fragment == nil else {
            throw SMARTFlintError(code: "invalid_base_url", message: "Use HTTPS outside loopback and a plain service base URL.")
        }
        self.baseURL = baseURL
        self.session = session ?? URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    }

    /// Present launchUrl in ASWebAuthenticationSession (or the system browser), then validate its callback.
    public func start(installationID: String, callbackURL: URL, mode: String = "gateway", launchTicket: String? = nil) async throws -> Launch {
        transactions = transactions.filter { $0.value.expiresAt > Date() }
        guard transactions.count < 8 else { throw SMARTFlintError(code: "too_many_launches", message: "Finish or cancel an earlier native launch first.") }
        let verifier = try Self.random()
        let state = try Self.random()
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var body = ["installationId": installationID, "redirectUri": callbackURL.absoluteString, "mode": mode, "codeChallenge": challenge, "state": state]
        if let launchTicket { body["launchTicket"] = launchTicket }
        let launch: Launch = try await request("/api/launches", method: "POST", body: body)
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiry = fractional.date(from: launch.expiresAt) ?? ISO8601DateFormatter().date(from: launch.expiresAt) else {
            throw SMARTFlintError(code: "invalid_expiry", message: "The launch expiry could not be parsed.")
        }
        transactions[state] = Transaction(verifier: verifier, callback: callbackURL, applicationId: launch.applicationId, expiresAt: expiry)
        return launch
    }

    /// Resume the one-use ticket delivered to the registered native callback by an EHR launch.
    public func resumeEHRLaunch(_ input: URL, mode: String = "gateway") async throws -> Launch {
        guard var components = URLComponents(url: input, resolvingAgainstBaseURL: false) else {
            throw SMARTFlintError(code: "invalid_launch_ticket", message: "An EHR launch callback is required.")
        }
        let tickets = (components.queryItems ?? []).filter { $0.name == "smart_flint_launch" }
        guard tickets.count == 1, let ticket = tickets[0].value, !ticket.isEmpty else {
            throw SMARTFlintError(code: "invalid_launch_ticket", message: "Exactly one EHR launch ticket is required.")
        }
        let remaining = (components.queryItems ?? []).filter { $0.name != "smart_flint_launch" }
        components.queryItems = remaining.isEmpty ? nil : remaining
        guard let callback = components.url, let escaped = ticket.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            throw SMARTFlintError(code: "invalid_callback", message: "The native callback is invalid.")
        }
        struct Bootstrap: Decodable { let installationId: String }
        let bootstrap: Bootstrap = try await request("/api/launches/bootstrap/\(escaped)")
        return try await start(installationID: bootstrap.installationId, callbackURL: callback, mode: mode, launchTicket: ticket)
    }

    /// Abandon in-memory transactions after cancellation or account switching.
    public func cancelPendingLaunches() { transactions.removeAll() }

    public func completeRedirect(_ callback: URL) async throws -> Session {
        guard var components = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
            throw SMARTFlintError(code: "invalid_callback", message: "A callback URL is required.")
        }
        let items = components.queryItems ?? []
        let reserved = Set(["code", "state", "error", "error_description"])
        for name in reserved where items.filter({ $0.name == name }).count > 1 {
            throw SMARTFlintError(code: "ambiguous_callback", message: "Duplicate authorization callback fields.")
        }
        guard let state = items.first(where: { $0.name == "state" })?.value, let transaction = transactions[state] else {
            throw SMARTFlintError(code: "invalid_state", message: "The callback has no matching native launch transaction.")
        }
        let remaining = items.filter { !reserved.contains($0.name) }
        components.queryItems = remaining.isEmpty ? nil : remaining
        guard components.url == transaction.callback else {
            throw SMARTFlintError(code: "callback_mismatch", message: "The callback does not match the registered app destination.")
        }
        transactions.removeValue(forKey: state)
        guard transaction.expiresAt > Date() else { throw SMARTFlintError(code: "launch_expired", message: "Start a new native launch.") }
        guard !items.contains(where: { $0.name == "error" }), let code = items.first(where: { $0.name == "code" })?.value else {
            throw SMARTFlintError(code: "authorization_failed", message: "Authorization did not complete.")
        }
        return try await request("/api/activations/redeem", method: "POST", body: [
            "code": code, "codeVerifier": transaction.verifier, "applicationId": transaction.applicationId, "redirectUri": transaction.callback.absoluteString,
        ])
    }

    public func descriptor(for activation: Session) async throws -> Activation {
        try await request("/api/activations/\(activation.activation.id)", bearer: activation.sessionToken)
    }

    /// Use the returned base URL and Authorization header with any preferred FHIR client.
    public func connection(for activation: Session, direct: Bool = false) async throws -> (baseURL: URL, authorization: String) {
        if !direct { return (activation.activation.gateway.baseUrl, "Bearer \(activation.sessionToken)") }
        let credential: Credential = try await request("/api/activations/\(activation.activation.id)/credentials", bearer: activation.sessionToken)
        return (credential.baseUrl, "\(credential.tokenType) \(credential.accessToken)")
    }

    /// Sensitive original-credential envelope (tokenResponse and refresh ownership metadata).
    /// Never log this data or include it in analytics.
    public func originalTokenResponse(for activation: Session) async throws -> Data {
        try await requestData("/api/activations/\(activation.activation.id)/credentials/original", bearer: activation.sessionToken)
    }

    public func handoff(for activation: Session) async throws -> Credential {
        try await request("/api/activations/\(activation.activation.id)/credentials/handoff", method: "POST", bearer: activation.sessionToken)
    }

    public func close(_ activation: Session) async throws {
        _ = try await requestData("/api/activations/\(activation.activation.id)", method: "DELETE", bearer: activation.sessionToken)
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil, bearer: String? = nil) async throws -> T {
        let data = try await requestData(path, method: method, body: body, bearer: bearer)
        return try JSONDecoder().decode(T.self, from: data)
    }
    private func requestData(_ path: String, method: String = "GET", body: [String: String]? = nil, bearer: String? = nil) async throws -> Data {
        guard let url = URL(string: baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw SMARTFlintError(code: "invalid_url", message: "Could not build the API URL.")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
            throw (try? JSONDecoder().decode(SMARTFlintError.self, from: data)) ?? SMARTFlintError(code: "request_failed", message: "The SMART Flint API request failed.")
        }
        return data
    }
    private static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SMARTFlintError(code: "random_unavailable", message: "Secure random generation failed.")
        }
        return base64URL(Data(bytes))
    }
    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
