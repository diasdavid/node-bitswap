'use strict'

/**
 * @typedef {import('ipfs-core-types/src/bitswap').WantListEntry} API
 */

/**
 * @implements {API}
 */
class WantListEntry {
  /**
   * @param {import('cids')} cid
   * @param {number} priority
   * @param {import('../message/message.proto').WantType} wantType
   */
  constructor (cid, priority, wantType) {
    // Keep track of how many requests we have for this key
    this._refCounter = 1

    this.cid = cid
    this.priority = priority || 1
    this.wantType = wantType
  }

  inc () {
    this._refCounter += 1
  }

  dec () {
    this._refCounter = Math.max(0, this._refCounter - 1)
  }

  hasRefs () {
    return this._refCounter > 0
  }

  // So that console.log prints a nice description of this object
  get [Symbol.toStringTag] () {
    const cidStr = this.cid.toString('base58btc')
    return `WantlistEntry <key: ${cidStr}, priority: ${this.priority}, refs: ${this._refCounter}>`
  }

  /**
   * @param {API} other
   * @returns {boolean}
   */
  equals (other) {
    // @ts-expect-error _refCounter is not specified by the interface
    return (this._refCounter === other._refCounter) &&
      this.cid.equals(other.cid) &&
      this.priority === other.priority &&
      // @ts-expect-error - wantType is not specified by the interface
      this.wantType === other.wantType
  }
}

module.exports = WantListEntry
