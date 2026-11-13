package expo.modules.motolink

import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import javax.crypto.Cipher

/**
 * Throwaway RSA-1024 key the dash expects in the CLIENT_INFO reply.
 *
 * The dash cannot tie the key to anything, so this is a format check rather
 * than authentication: any fresh key works. The key lives in memory only, so
 * the default (Conscrypt) provider is used and not the Android Keystore: the
 * Keystore refuses raw private-key "encryption", which is what the dash wants.
 */
class RsaIdentity {
  private val keyPair: KeyPair = KeyPairGenerator.getInstance("RSA").run {
    initialize(1024)
    generateKeyPair()
  }

  /**
   * base64 X.509 SubjectPublicKeyInfo, no line wrapping. Java's encoded form
   * of an RSA public key already is SubjectPublicKeyInfo, unlike iOS which
   * exports bare PKCS#1 and has to wrap it.
   */
  fun publicKeyBase64(): String = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP)

  /**
   * PKCS#1 v1.5 private-key operation (block type 1, no digest) over the HUID
   * bytes. This is exactly `RSA/ECB/PKCS1Padding` in ENCRYPT_MODE with the
   * private key, which is what the reference Android implementations send.
   */
  fun sign(huid: String): String {
    val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
    cipher.init(Cipher.ENCRYPT_MODE, keyPair.private)
    val signature = cipher.doFinal(huid.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(signature, Base64.NO_WRAP)
  }
}
