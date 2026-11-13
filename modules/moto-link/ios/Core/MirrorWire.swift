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
///   app -> extension   strip     [5][enabled u8][edge u8][height u32][background rgb][text rgb][accent rgb]
///                                [len u8][left utf8][len u8][center utf8][len u8][right utf8]
///   extension -> app   frame     [3][flags u8, bit0 = keyframe][length u32][Annex-B access unit]
///
/// All integers little-endian. Colours are three u8. Strip texts are at most
/// 64 bytes each. This file is compiled into both targets.
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

  /// A band of three short texts beside the mirrored picture (speed, clock,
  /// song). The app owns the data; the extension draws it because it is the
  /// one producing the frames. Height is in thousandths of the dash height.
  struct Strip: Equatable {
    enum Edge: UInt8 {
      case bottom = 0
      case top = 1
    }

    struct Color: Equatable {
      var red: UInt8
      var green: UInt8
      var blue: UInt8
    }

    static let minHeight = 60
    static let maxHeight = 400
    static let maxTextBytes = 64

    var enabled = false
    var edge = Edge.bottom
    var height = 150
    var left = ""
    var center = ""
    var right = ""
    var background = Color(red: 0x10, green: 0x10, blue: 0x10)
    var text = Color(red: 0xFF, green: 0xFF, blue: 0xFF)
    var accent = Color(red: 0xFF, green: 0x8C, blue: 0x00)

    /// Values that fit the wire format and leave room for a picture.
    var sanitized: Strip {
      var out = self
      out.height = min(max(height, Strip.minHeight), Strip.maxHeight)
      out.left = Strip.clip(left)
      out.center = Strip.clip(center)
      out.right = Strip.clip(right)
      return out
    }

    /// One line only, cut on a character boundary so the bytes stay valid UTF-8.
    private static func clip(_ text: String) -> String {
      var out = ""
      var bytes = 0
      for character in text {
        let character: Character = character.isNewline ? " " : character
        let size = character.utf8.count
        if bytes + size > maxTextBytes { break }
        out.append(character)
        bytes += size
      }
      return out
    }
  }

  enum Message: Equatable {
    case config(Config)
    case view(View)
    case strip(Strip)
    case keyframe
    case frame(data: Data, isKeyframe: Bool)
  }

  private static let typeConfig: UInt8 = 1
  private static let typeKeyframe: UInt8 = 2
  private static let typeFrame: UInt8 = 3
  private static let typeView: UInt8 = 4
  private static let typeStrip: UInt8 = 5
  /// Type, enabled, edge, height and three colours: everything before the texts.
  private static let stripFixed = 16
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
    case .strip(let raw):
      // Sanitising here keeps every text within the u8 length prefix.
      let strip = raw.sanitized
      out.append(typeStrip)
      out.append(strip.enabled ? 1 : 0)
      out.append(strip.edge.rawValue)
      append(UInt32(clamping: strip.height), to: &out)
      for color in [strip.background, strip.text, strip.accent] {
        out.append(contentsOf: [color.red, color.green, color.blue])
      }
      for text in [strip.left, strip.center, strip.right] {
        let bytes = Array(text.utf8)
        out.append(UInt8(bytes.count))
        out.append(contentsOf: bytes)
      }
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

    /// The strip and its byte size, or nil when more bytes are needed. Sets
    /// `failed` for values no honest sender produces, since the stream has no
    /// way to resynchronise after a bad length.
    private mutating func parseStrip(at offset: Int) -> (Strip, Int)? {
      guard buffer.count - offset >= MirrorWire.stripFixed else { return nil }
      let enabled = buffer[offset + 1]
      guard enabled <= 1, let edge = Strip.Edge(rawValue: buffer[offset + 2]) else {
        failed = true
        return nil
      }
      func color(_ at: Int) -> Strip.Color {
        Strip.Color(red: buffer[at], green: buffer[at + 1], blue: buffer[at + 2])
      }
      var cursor = offset + MirrorWire.stripFixed
      var texts: [String] = []
      for _ in 0..<3 {
        guard cursor < buffer.count else { return nil }
        let length = Int(buffer[cursor])
        guard length <= Strip.maxTextBytes else {
          failed = true
          return nil
        }
        guard buffer.count - cursor - 1 >= length else { return nil }
        texts.append(String(decoding: buffer[(cursor + 1)..<(cursor + 1 + length)], as: UTF8.self))
        cursor += 1 + length
      }
      let strip = Strip(
        enabled: enabled == 1,
        edge: edge,
        height: u32(offset + 3),
        left: texts[0],
        center: texts[1],
        right: texts[2],
        background: color(offset + 7),
        text: color(offset + 10),
        accent: color(offset + 13)
      )
      return (strip.sanitized, cursor - offset)
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
        case MirrorWire.typeStrip:
          guard let parsed = parseStrip(at: offset) else { break parse }
          messages.append(.strip(parsed.0))
          offset += parsed.1
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
