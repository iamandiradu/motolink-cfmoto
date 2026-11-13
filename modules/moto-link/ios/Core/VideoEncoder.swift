import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// H.264 encoder for the dash: Baseline 3.1, no B-frames, Annex-B output with
/// SPS/PPS in front of every keyframe.
final class VideoEncoder {
  struct Config: Equatable {
    var width: Int
    var height: Int
    var fps: Int
    var bitrate: Int
    var keyframeIntervalSec: Int
  }

  let config: Config
  private var session: VTCompressionSession?
  private let output: (Data, Bool) -> Void
  private let stateLock = NSLock()
  private var forceKeyframe = true
  private var frameIndex: Int64 = 0

  /// `output` receives one Annex-B access unit and whether it is a keyframe.
  init(config: Config, output: @escaping (Data, Bool) -> Void) throws {
    self.config = config
    self.output = output

    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(config.width),
      height: Int32(config.height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created
    )
    guard status == noErr, let session = created else {
      throw NSError(domain: "MotoLink.VideoEncoder", code: Int(status))
    }
    self.session = session

    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Baseline_3_1,
      // The wire format has no timestamps: frames must leave in display order.
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_AverageBitRate: config.bitrate,
      kVTCompressionPropertyKey_ExpectedFrameRate: config.fps,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: config.fps * config.keyframeIntervalSec,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: config.keyframeIntervalSec,
    ]
    for (key, value) in properties {
      VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
  }

  deinit {
    invalidate()
  }

  func invalidate() {
    stateLock.lock()
    let old = session
    session = nil
    stateLock.unlock()
    if let old {
      VTCompressionSessionInvalidate(old)
    }
  }

  func requestKeyframe() {
    stateLock.lock()
    forceKeyframe = true
    stateLock.unlock()
  }

  func makePixelBuffer() -> CVPixelBuffer? {
    let attributes: [CFString: Any] = [
      kCVPixelBufferCGImageCompatibilityKey: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey: true,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(
      kCFAllocatorDefault,
      config.width,
      config.height,
      kCVPixelFormatType_32BGRA,
      attributes as CFDictionary,
      &buffer
    )
    return buffer
  }

  func encode(_ pixelBuffer: CVPixelBuffer) {
    stateLock.lock()
    guard let session else {
      stateLock.unlock()
      return
    }
    let keyframe = forceKeyframe
    forceKeyframe = false
    let index = frameIndex
    frameIndex += 1
    stateLock.unlock()

    let time = CMTime(value: index, timescale: CMTimeScale(max(1, config.fps)))
    let frameProperties: CFDictionary? =
      keyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil

    VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: time,
      duration: .invalid,
      frameProperties: frameProperties,
      infoFlagsOut: nil
    ) { [weak self] status, _, sampleBuffer in
      guard status == noErr, let sampleBuffer, let self else { return }
      guard let unit = AnnexB.accessUnit(from: sampleBuffer) else { return }
      self.output(unit.data, unit.isKeyframe)
    }
  }
}

/// VideoToolbox emits AVCC: length-prefixed NAL units, with the parameter sets
/// kept out of band in the format description. The dash wants Annex-B: start
/// codes, and SPS+PPS in the same access unit as every IDR.
enum AnnexB {
  static let startCode: [UInt8] = [0, 0, 0, 1]

  static func accessUnit(from sampleBuffer: CMSampleBuffer) -> (data: Data, isKeyframe: Bool)? {
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }

    var isKeyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
      as? [[CFString: Any]],
      let first = attachments.first,
      let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool
    {
      isKeyframe = !notSync
    }

    var out = Data()
    var lengthSize: Int32 = 4

    if let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
      var count = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: &lengthSize
      )
      if isKeyframe {
        for index in 0..<count {
          var pointer: UnsafePointer<UInt8>?
          var size = 0
          let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: index,
            parameterSetPointerOut: &pointer,
            parameterSetSizeOut: &size,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: nil
          )
          if status == noErr, let pointer {
            out.append(contentsOf: startCode)
            out.append(pointer, count: size)
          }
        }
      }
    }

    let total = CMBlockBufferGetDataLength(block)
    var avcc = Data(count: total)
    let copied = avcc.withUnsafeMutableBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: base)
    }
    guard copied == noErr else { return nil }

    out.append(convert(avcc: avcc, lengthSize: Int(lengthSize)))
    return (out, isKeyframe)
  }

  /// Rewrites each big-endian length prefix as a 00 00 00 01 start code.
  static func convert(avcc: Data, lengthSize: Int) -> Data {
    var out = Data(capacity: avcc.count + 16)
    let bytes = [UInt8](avcc)
    var offset = 0
    while offset + lengthSize <= bytes.count {
      var length = 0
      for i in 0..<lengthSize {
        length = (length << 8) | Int(bytes[offset + i])
      }
      offset += lengthSize
      guard length > 0, offset + length <= bytes.count else { break }
      // Drop SEI (type 6). VideoToolbox adds it; the dash decoder needs only
      // parameter sets and slices, and the reference streams carry none.
      if bytes[offset] & 0x1F != 6 {
        out.append(contentsOf: startCode)
        out.append(contentsOf: bytes[offset..<(offset + length)])
      }
      offset += length
    }
    return out
  }
}
