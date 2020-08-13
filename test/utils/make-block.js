'use strict'

const multihashing = require('multihashing-async')
const CID = require('cids')
const Block = require('ipld-block')
const randomBytes = require('iso-random-stream/src/random')
const range = require('lodash.range')
const uint8ArrayFromString = require('uint8arrays/from-string')
const { v4: uuid } = require('uuid')

module.exports = async (count, size) => {
  const blocks = await Promise.all(
    range(count || 1).map(async () => {
      const data = size ? randomBytes(size) : uint8ArrayFromString(`hello world ${uuid()}`)
      const hash = await multihashing(data, 'sha2-256')
      return new Block(data, new CID(hash))
    })
  )

  return count ? blocks : blocks[0]
}
