import * as webcrypto from './webcrypto.js'

/**
 * @param {CryptoKey} key
 */
export const exportKeyJwk = async key => {
  const jwk = await webcrypto.subtle.exportKey('jwk', key)
  jwk.key_ops = key.usages
  return jwk
}

/**
 * Only suited for exporting public keys.
 *
 * @param {CryptoKey} key
 * @return {Promise<Uint8Array<ArrayBuffer>>}
 */
export const exportKeyRaw = key =>
  webcrypto.subtle.exportKey('raw', key).then(key => new Uint8Array(key))
