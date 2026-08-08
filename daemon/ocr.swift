// macOS Vision OCR — native, zero dependencies, no network.
// Usage: swift ocr.swift <image-path>
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
    exit(1)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([req])
    guard let obs = req.results else { exit(0) }
    // Emit in reading order (top to bottom); Vision returns bottom-left origin.
    let lines = obs.compactMap { o -> (CGFloat, String)? in
        guard let t = o.topCandidates(1).first?.string else { return nil }
        return (o.boundingBox.origin.y, t)
    }.sorted { $0.0 > $1.0 }.map { $0.1 }
    print(lines.joined(separator: "\n"))
} catch {
    FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
