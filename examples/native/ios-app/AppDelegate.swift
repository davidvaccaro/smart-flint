import UIKit
import SMARTFlintNativeExample

// Create an iOS UIKit app, add the local ../swift package, replace its app entry point
// with this file, and apply the Info.plist URL type shown alongside it.
@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let screen = SMARTFlintSampleViewController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = screen
        window?.makeKeyAndVisible()
        return true
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == "org.smartflint.sample", url.host == "callback",
              URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "smart_flint_launch" }) == true else { return false }
        screen.connect(incomingEHRLaunch: url)
        return true
    }
}

@MainActor
final class SMARTFlintSampleViewController: UIViewController {
    // Configure these three values from your application's installation worksheet.
    private let client = try! SMARTFlintClient(baseURL: URL(string: "https://flint.example.com")!)
    private let installationID = "replace-with-your-installation-id"
    private let callback = URL(string: "org.smartflint.sample://callback")!
    private let browser = SMARTFlintWebAuthentication()
    private var activation: SMARTFlintClient.Session?
    private var busy = false
    private let status = UILabel()
    private let connectButton = UIButton(type: .system)
    private let disconnectButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.numberOfLines = 0
        status.text = "Connect your record using SMART Flint."
        connectButton.setTitle("Connect record", for: .normal)
        connectButton.addTarget(self, action: #selector(begin), for: .touchUpInside)
        disconnectButton.setTitle("Disconnect", for: .normal)
        disconnectButton.addTarget(self, action: #selector(disconnect), for: .touchUpInside)
        disconnectButton.isEnabled = false
        let stack = UIStackView(arrangedSubviews: [status, connectButton, disconnectButton])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
        ])
    }

    @objc private func begin() { connect() }

    func connect(incomingEHRLaunch: URL? = nil) {
        guard !busy, let anchor = view.window else { return }
        guard activation == nil || incomingEHRLaunch != nil else { return }
        let previous = incomingEHRLaunch == nil ? nil : activation
        if incomingEHRLaunch != nil {
            activation = nil
            status.text = "Connecting the record from this EHR launch…"
        }
        updateBusy(true)
        Task {
            defer { updateBusy(false) }
            do {
                // A new EHR launch cannot keep rendering the previous patient's activation.
                if let previous { try? await client.close(previous) }
                let session = try await browser.signIn(client: client, installationID: installationID,
                    callbackURL: callback, presentationAnchor: anchor, incomingEHRLaunch: incomingEHRLaunch)
                // Pass this endpoint and authorization header to any preferred FHIR client.
                _ = try await client.connection(for: session)
                activation = session
                status.text = "Record connected. Patient context: \(session.activation.context.patient?.reference ?? "Not supplied"). Your FHIR client can now use this activation."
            } catch {
                status.text = "Sign-in did not complete. Start a fresh launch when ready."
            }
        }
    }

    @objc private func disconnect() {
        guard !busy, let session = activation else { return }
        updateBusy(true)
        Task {
            defer { updateBusy(false) }
            do { try await client.close(session); activation = nil; status.text = "Disconnected." }
            catch { status.text = "Disconnect could not finish. Try again." }
        }
    }

    private func updateBusy(_ value: Bool) {
        busy = value
        connectButton.isEnabled = !value && activation == nil
        disconnectButton.isEnabled = !value && activation != nil
    }
}
