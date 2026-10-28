// swift-tools-version: 5.8
import PackageDescription

let package = Package(
    name: "SMARTFlintNativeExample",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "SMARTFlintNativeExample", targets: ["SMARTFlintNativeExample"])],
    targets: [
        .target(name: "SMARTFlintNativeExample"),
        .testTarget(name: "SMARTFlintNativeExampleTests", dependencies: ["SMARTFlintNativeExample"])
    ]
)
