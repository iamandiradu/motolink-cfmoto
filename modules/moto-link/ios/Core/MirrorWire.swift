import Foundation

/// Messages between the app and its screen-broadcast extension.
///
/// The extension sees the phone screen (Waze, anything) but lives in its own
/// process with a 50 MB cap. The app holds the dash connection. They talk over
/// a loopback TCP socket: the extension scales and encodes, the app forwards.
///
///   app -> extension   config    [1][w i32][h i32][fps i32][bitrate i32][keyframeSec i32]
///   app -> extension   keyframe  [2]
///   app -> extension   view      [4][zoom][trimTop][trimBottom][trimLeft][trimRight][fit], each u32
///   extension -> app   frame     [3][flags u8, bit0 = keyframe][length u32][Annex-B access unit]
///
/// All integers little-endian. This file is compiled into both targets.
enum MirrorWire {
  static let port: UInt16 = 47810

  struct Config: Equatable {
    var width: Int
    var height: Int
    var fps: Int
    var bitrate: Int
    var keyframeIntervalSec: Int
  }

  /// How the phone screen is placed on the dash. Trims and zoom are in
  /// thousandths: trimTop 60 cuts the top 6 % of the upright screen, zoom 1250
  /// enlarges by a quarter.
  struct View: Equatable {
    enum Fit: UInt32 {
      /// Sideways screen fills the dash, upright screen is shown whole.
      case auto = 0
      /// Always fill the dash; edges may be cut.
      case fill = 1
      /// Always show everything; bars may appear.
      case fit = 2
    }

    var zoom = 1000
    var trimTop = 0
    var trimBottom = 0
    var trimLeft = 0
    var trimRight = 0
    var fit = Fit.auto

    /// Values an arbitrary sender could not use to produce an empty picture.
    var sanitized: View {
      func trim(_ value: Int) -> Int { min(max(value, 0), 400) }
      var out = self
      out.zoom = min(max(zoom, 1000), 3000)
      out.trimTop = trim(trimTop)
      out.trimBottom = trim(trimBottom)
      out.trimLeft = trim(trimLeft)
      out.trimRight = trim(trimRight)
      return out
    }
  }

  enum Message: Equatable {
    case config(Config)
    case view(View)
    case keyframe
    case frame(data: Data, isKeyframe: Bool)
  }

  private static let typeConfig: UInt8 = 1
  private static let typeKeyframe: UInt8 = 2
  private static let typeFrame: UInt8 = 3
  private static let typeView: UInt8 = 4
  /// Refuse absurd lengths so a corrupt stream cannot exhaust memory.
  private static let maxFrame = 4 * 1024 * 1024

  static func encode(_ message: Message) -> Data {
    var out = Data()
    switch message {
    case .config(let config):
      out.append(typeConfig)
      for value in [config.width, config.height, config.fps, config.bitrate, config.keyframeIntervalSec] {
        append(UInt32(clamping: value), to: &out)
      }
    case .view(let view):
      out.append(typeView)
      for value in [view.zoom, view.trimTop, view.trimBottom, view.trimLeft, view.trimRight] {
        append(UInt32(clamping: value), to: &out)
      }
      append(view.fit.rawValue, to: &out)
    case .keyframe:
      out.append(typeKeyframe)
    case .frame(let data, let isKeyframe):
      out.reserveCapacity(data.count + 6)
      out.append(typeFrame)
      out.append(isKeyframe ? 1 : 0)
      append(UInt32(data.count), to: &out)
      out.append(data)
    }
    return out
  }

  private static func append(_ value: UInt32, to data: inout Data) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }

  /// Incremental parser for one direction of the socket.
  struct Parser {
    private var buffer = [UInt8]()
    private(set) var failed = false

    private func u32(_ offset: Int) -> Int {
      Int(buffer[offset]) | Int(buffer[offset + 1]) << 8 | Int(buffer[offset + 2]) << 16 | Int(buffer[offset + 3]) << 24
    }

    mutating func push(_ chunk: Data) -> [Message] {
      guard !failed else { return [] }
      buffer.append(contentsOf: chunk)
      var messages: [Message] = []
      var offset = 0

      parse: while offset < buffer.count {
        switch buffer[offset] {
        case MirrorWire.typeConfig:
          guard buffer.count - offset >= 21 else { break parse }
          let base = offset + 1
          messages.append(
            .config(
              Config(
                width: u32(base),
                height: u32(base + 4),
                fps: u32(base + 8),
                bitrate: u32(base + 12),
                keyframeIntervalSec: u32(base + 16)
              )))
          offset += 21
        case MirrorWire.typeKeyframe:
          messages.append(.keyframe)
          offset += 1
        case MirrorWire.typeView:
          guard buffer.count - offset >= 25 else { break parse }
          let base = offset + 1
          messages.append(
            .view(
              View(
                zoom: u32(base),
                trimTop: u32(base + 4),
                trimBottom: u32(base + 8),
                trimLeft: u32(base + 12),
                trimRight: u32(base + 16),
                fit: View.Fit(rawValue: UInt32(u32(base + 20))) ?? .auto
              ).sanitized))
          offset += 25
        case MirrorWire.typeFrame:
          guard buffer.count - offset >= 6 else { break parse }
          let length = u32(offset + 2)
          guard length <= MirrorWire.maxFrame else {
            failed = true
            break parse
          }
          guard buffer.count - offset >= 6 + length else { break parse }
          let start = offset + 6
          messages.append(.frame(data: Data(buffer[start..<(start + length)]), isKeyframe: buffer[offset + 1] & 1 == 1))
          offset += 6 + length
        default:
          failed = true
          break parse
        }
      }

      if failed {
        buffer.removeAll()
      } else if offset > 0 {
        buffer.removeFirst(offset)
      }
      return messages
    }
  }
}
