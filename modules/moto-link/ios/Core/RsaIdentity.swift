import Foundation
import Security

/// Throwaway RSA-1024 key the dash expects in the CLIENT_INFO reply.
///
/// The dash cannot tie the key to anything, so this is a format check rather
/// than authentication: any fresh key works. The key lives in memory only.
final class RsaIdentity {
  enum IdentityError: Error {
    case keyGeneration(String)
    case export(String)
    case sign(String)
  }

  private let privateKey: SecKey

  init() throws {
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeySizeInBits as String: 1024,
      kSecAttrIsPermanent as String: false,
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw IdentityError.keyGeneration(String(describing: error?.takeRetainedValue()))
    }
    privateKey = key
  }

  /// base64 X.509 SubjectPublicKeyInfo, no line wrapping.
  func publicKeyBase64() throws -> String {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw IdentityError.export("no public key")
    }
    var error: Unmanaged<CFError>?
    guard let pkcs1 = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw IdentityError.export(String(describing: error?.takeRetainedValue()))
    }
    return RsaIdentity.subjectPublicKeyInfo(pkcs1: pkcs1).base64EncodedString()
  }

  /// Raw PKCS#1 v1.5 private-key operation (type-1 padding, no digest) over the
  /// HUID bytes. Same bytes as Java's `RSA/ECB/PKCS1Padding` encrypt with a
  /// private key, which is what the reference implementations send.
  func sign(huid: String) throws -> String {
    var error: Unmanaged<CFError>?
    guard
      let signature = SecKeyCreateSignature(
        privateKey,
        .rsaSignatureDigestPKCS1v15Raw,
        Data(huid.utf8) as CFData,
        &error
      ) as Data?
    else {
      throw IdentityError.sign(String(describing: error?.takeRetainedValue()))
    }
    return signature.base64EncodedString()
  }

  /// Security.framework exports a bare PKCS#1 RSAPublicKey. The dash wants it
  /// wrapped: SEQUENCE { SEQUENCE { rsaEncryption OID, NULL }, BIT STRING { key } }.
  static func subjectPublicKeyInfo(pkcs1: Data) -> Data {
    let algorithm: [UInt8] = [
      0x30, 0x0D,
      0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01,
      0x05, 0x00,
    ]
    var bitString = Data([0x03])
    bitString.append(derLength(pkcs1.count + 1))
    bitString.append(0x00)
    bitString.append(pkcs1)

    var out = Data([0x30])
    out.append(derLength(algorithm.count + bitString.count))
    out.append(contentsOf: algorithm)
    out.append(bitString)
    return out
  }

  static func derLength(_ length: Int) -> Data {
    if length < 0x80 { return Data([UInt8(length)]) }
    var bytes: [UInt8] = []
    var value = length
    while value > 0 {
      bytes.insert(UInt8(value & 0xFF), at: 0)
      value >>= 8
    }
    return Data([0x80 | UInt8(bytes.count)] + bytes)
  }
}
