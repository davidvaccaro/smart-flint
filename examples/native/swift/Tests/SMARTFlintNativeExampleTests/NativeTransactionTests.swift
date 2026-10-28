import XCTest
import Foundation
import CryptoKit
@testable import SMARTFlintNativeExample

private final class SyntheticProtocol: URLProtocol {
    static var respond: ((URLRequest) throws -> [String: Any])?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "native-api.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.respond else { throw URLError(.badServerResponse) }
            let object = try handler(request)
            let data = try JSONSerialization.data(withJSONObject: object)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class NativeTransactionTests: XCTestCase {
    override func tearDown() { SyntheticProtocol.respond = nil; super.tearDown() }

    private func makeClient() throws -> SMARTFlintClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SyntheticProtocol.self]
        return try SMARTFlintClient(baseURL: URL(string: "https://native-api.example")!, session: URLSession(configuration: configuration))
    }
    private func launchResponse(expiry: String = "2099-01-01T00:00:00.000Z") -> [String: Any] {
        ["launchUrl": "https://native-api.example/launch/synthetic", "expiresAt": expiry, "applicationId": "app-native"]
    }
    private func activatedResponse() -> [String: Any] {
        let activation: [String: Any] = ["id": "act-native", "mode": "gateway", "status": "active",
            "context": ["patient": ["reference": "Patient/synthetic"]], "upstream": ["baseUrl": "https://ehr.example/fhir", "fhirVersion": "4.0.1"],
            "gateway": ["baseUrl": "https://native-api.example/fhir/act-native"], "refreshOwner": "bridge", "tokenExportAllowed": false]
        return ["activation": activation, "sessionToken": "synthetic-native-session"]
    }
    private func body(_ request: URLRequest) throws -> [String: String] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let size = stream.read(&buffer, maxLength: buffer.count)
                if size == 0 { break }
                if size < 0 { throw URLError(.cannotDecodeRawData) }
                data.append(buffer, count: size)
            }
        }
        guard !data.isEmpty else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode([String: String].self, from: data)
    }

    func testPKCECallbackBindingAndOneUseRedemption() async throws {
        let client = try makeClient()
        var started: [String: String] = [:]
        var redemptions = 0
        SyntheticProtocol.respond = { request in
            if request.url!.path == "/api/launches" {
                started = try self.body(request)
                return self.launchResponse()
            }
            XCTAssertEqual(request.url!.path, "/api/activations/redeem")
            let redeemed = try self.body(request)
            let digest = Data(SHA256.hash(data: Data(redeemed["codeVerifier"]!.utf8)))
                .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            XCTAssertEqual(digest, started["codeChallenge"])
            XCTAssertEqual(redeemed["applicationId"], "app-native")
            XCTAssertEqual(redeemed["redirectUri"], "org.smartflint.sample://callback")
            redemptions += 1
            return self.activatedResponse()
        }
        _ = try await client.start(installationID: "installation-native", callbackURL: URL(string: "org.smartflint.sample://callback")!)
        let state = try XCTUnwrap(started["state"])
        do {
            _ = try await client.completeRedirect(URL(string: "org.attacker.sample://callback?state=\(state)&code=synthetic")!)
            XCTFail("Mismatched callback should fail")
        } catch let error as SMARTFlintClient.SMARTFlintError { XCTAssertEqual(error.code, "callback_mismatch") }
        XCTAssertEqual(redemptions, 0)
        let callback = URL(string: "org.smartflint.sample://callback?state=\(state)&code=synthetic")!
        let activated = try await client.completeRedirect(callback)
        XCTAssertEqual(activated.activation.context.patient?.reference, "Patient/synthetic")
        XCTAssertFalse(activated.description.contains("synthetic-native-session"))
        let gateway = try await client.connection(for: activated)
        XCTAssertEqual(gateway.baseURL.absoluteString, "https://native-api.example/fhir/act-native")
        XCTAssertEqual(gateway.authorization, "Bearer synthetic-native-session")
        do { _ = try await client.completeRedirect(callback); XCTFail("Transaction replay should fail") }
        catch let error as SMARTFlintClient.SMARTFlintError { XCTAssertEqual(error.code, "invalid_state") }
        XCTAssertEqual(redemptions, 1)
    }

    func testExpiredAndCancelledNativeTransactionsDoNotRedeem() async throws {
        let client = try makeClient()
        var state = ""
        SyntheticProtocol.respond = { request in
            XCTAssertEqual(request.url!.path, "/api/launches")
            state = try self.body(request)["state"]!
            return self.launchResponse(expiry: "2020-01-01T00:00:00.000Z")
        }
        _ = try await client.start(installationID: "installation-native", callbackURL: URL(string: "org.smartflint.sample://callback")!)
        do { _ = try await client.completeRedirect(URL(string: "org.smartflint.sample://callback?state=\(state)&code=synthetic")!); XCTFail("Expired launch should fail") }
        catch let error as SMARTFlintClient.SMARTFlintError { XCTAssertEqual(error.code, "launch_expired") }
        _ = try await client.start(installationID: "installation-native", callbackURL: URL(string: "org.smartflint.sample://callback")!)
        await client.cancelPendingLaunches()
        do { _ = try await client.completeRedirect(URL(string: "org.smartflint.sample://callback?state=\(state)&code=synthetic")!); XCTFail("Cancelled launch should fail") }
        catch let error as SMARTFlintClient.SMARTFlintError { XCTAssertEqual(error.code, "invalid_state") }
    }

    func testEHRLaunchTicketResumesIntoNativeOwnedTransaction() async throws {
        let client = try makeClient()
        var calls = 0
        SyntheticProtocol.respond = { request in
            calls += 1
            if calls == 1 {
                XCTAssertEqual(request.url!.path, "/api/launches/bootstrap/synthetic-ticket")
                return ["installationId": "installation-native"]
            }
            let started = try self.body(request)
            XCTAssertEqual(started["launchTicket"], "synthetic-ticket")
            XCTAssertEqual(started["redirectUri"], "org.smartflint.sample://callback")
            XCTAssertEqual(started["installationId"], "installation-native")
            XCTAssertEqual(started["codeChallenge"]?.count, 43)
            return self.launchResponse()
        }
        _ = try await client.resumeEHRLaunch(URL(string: "org.smartflint.sample://callback?smart_flint_launch=synthetic-ticket")!)
        XCTAssertEqual(calls, 2)
    }
}
