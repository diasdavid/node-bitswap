/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { Ledger } from '../../src/decision-engine/ledger.js'

/**
 * @typedef {import('@libp2p/interface-peer-id').PeerId} PeerId
 */

describe('Ledger', () => {
  /** @type {PeerId} */
  let peerId
  /** @type {Ledger} */
  let ledger

  before(async () => {
    peerId = await createEd25519PeerId()
  })

  beforeEach(() => {
    ledger = new Ledger(peerId)
  })

  it('accounts', () => {
    expect(ledger.debtRatio()).to.eql(0)

    ledger.sentBytes(100)
    ledger.sentBytes(12000)
    ledger.receivedBytes(223432)
    ledger.receivedBytes(2333)

    expect(ledger.accounting)
      .to.eql({
        bytesSent: 100 + 12000,
        bytesRecv: 223432 + 2333
      })
    expect(ledger.debtRatio())
      .to.eql((100 + 12000) / (223432 + 2333 + 1))
  })
})
