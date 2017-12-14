/* eslint-env mocha */
/* eslint max-nested-callbacks: ["error", 8] */
'use strict'

const eachSeries = require('async/eachSeries')
const waterfall = require('async/waterfall')
const map = require('async/map')
const parallel = require('async/parallel')
const setImmediate = require('async/setImmediate')
const _ = require('lodash')
const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const PeerId = require('peer-id')

const Message = require('../src/types/message')
const Bitswap = require('../src')

const createTempRepo = require('./utils/create-temp-repo-nodejs')
const mockNetwork = require('./utils/mocks').mockNetwork
const applyNetwork = require('./utils/mocks').applyNetwork
const mockLibp2pNode = require('./utils/mocks').mockLibp2pNode
const storeHasBlocks = require('./utils/store-has-blocks')
const makeBlock = require('./utils/make-block')
const orderedFinish = require('./utils/helpers').orderedFinish

describe('bitswap with mocks', function () {
  this.timeout(10 * 1000)

  let repo
  let blocks
  let ids

  before((done) => {
    parallel([
      (cb) => createTempRepo(cb),
      (cb) => map(_.range(15), (i, cb) => makeBlock(cb), cb),
      (cb) => map(_.range(2), (i, cb) => PeerId.create({bits: 1024}, cb), cb)
    ], (err, results) => {
      if (err) {
        return done(err)
      }

      repo = results[0]
      blocks = results[1]
      ids = results[2]

      done()
    })
  })

  after((done) => {
    repo.teardown(done)
  })

  describe('receive message', () => {
    it('simple block message', (done) => {
      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)
      bs.start((err) => {
        expect(err).to.not.exist()

        const other = ids[1]

        const b1 = blocks[0]
        const b2 = blocks[1]

        const msg = new Message(false)
        msg.addBlock(b1)
        msg.addBlock(b2)

        bs._receiveMessage(other, msg, (err) => {
          expect(err).to.not.exist()

          map([b1.cid, b2.cid], (cid, cb) => repo.blocks.get(cid, cb), (err, blocks) => {
            expect(err).to.not.exist()

            expect(blocks[0].data).to.eql(b1.data)
            expect(blocks[1].data).to.eql(b2.data)
            done()
          })
        })
      })
    })

    it('simple want message', (done) => {
      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)
      bs.start((err) => {
        expect(err).to.not.exist()
        const other = ids[1]
        const b1 = blocks[0]
        const b2 = blocks[1]

        const msg = new Message(false)

        msg.addEntry(b1.cid, 1, false)
        msg.addEntry(b2.cid, 1, false)

        bs._receiveMessage(other, msg, (err) => {
          expect(err).to.not.exist()

          const wl = bs.wantlistForPeer(other)

          expect(wl.has(b1.cid.buffer.toString())).to.eql(true)
          expect(wl.has(b2.cid.buffer.toString())).to.eql(true)

          done()
        })
      })
    })

    it('multi peer', function (done) {
      this.timeout(80 * 1000)
      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)

      let others
      let blocks

      bs.start((err) => {
        expect(err).to.not.exist()

        parallel([
          (cb) => map(_.range(5), (i, cb) => PeerId.create(cb), cb),
          (cb) => map(_.range(10), (i, cb) => makeBlock(cb), cb)
        ], (err, results) => {
          expect(err).to.not.exist()

          others = results[0]
          blocks = results[1]
          test()
        })

        function test () {
          map(_.range(5), (i, cb) => {
            const msg = new Message(false)
            msg.addBlock(blocks[i])
            msg.addBlock(blocks[5 + 1])
            cb(null, msg)
          }, (err, messages) => {
            expect(err).to.not.exist()
            let i = 0
            eachSeries(others, (other, cb) => {
              const msg = messages[i]
              i++
              bs._receiveMessage(other, msg, (err) => {
                expect(err).to.not.exist()
                storeHasBlocks(msg, repo.blocks, cb)
              })
            }, done)
          })
        }
      })
    })
  })

  describe('get', () => {
    it('fails on requesting empty block', (done) => {
      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)
      bs.get(null, (err, res) => {
        expect(err).to.exist()
        expect(err.message).to.equal('Not a valid cid')
        done()
      })
    })

    it('block exists locally', (done) => {
      const block = blocks[4]

      repo.blocks.put(block, (err) => {
        expect(err).to.not.exist()
        const bs = new Bitswap(mockLibp2pNode(), repo.blocks)

        bs.get(block.cid, (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.eql(block)
          done()
        })
      })
    })

    it('blocks exist locally', (done) => {
      const b1 = blocks[3]
      const b2 = blocks[14]
      const b3 = blocks[13]

      repo.blocks.putMany([b1, b2, b3], (err) => {
        expect(err).to.not.exist()

        const bs = new Bitswap(mockLibp2pNode(), repo.blocks)

        bs.getMany([b1.cid, b2.cid, b3.cid], (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.be.eql([b1, b2, b3])
          done()
        })
      })
    })

    it('getMany', (done) => {
      const b1 = blocks[5]
      const b2 = blocks[6]
      const b3 = blocks[7]

      repo.blocks.putMany([b1, b2, b3], (err) => {
        expect(err).to.not.exist()

        const bs = new Bitswap(mockLibp2pNode(), repo.blocks)

        map([b1.cid, b2.cid, b3.cid], (cid, cb) => bs.get(cid, cb), (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.eql([b1, b2, b3])
          done()
        })
      })
    })

    it('block is added locally afterwards', (done) => {
      const finish = orderedFinish(2, done)
      const block = blocks[9]
      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)
      const net = mockNetwork()

      bs.network = net
      bs.wm.network = net
      bs.engine.network = net
      bs.start((err) => {
        expect(err).to.not.exist()
        bs.get(block.cid, (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.eql(block)
          finish(2)
        })

        setTimeout(() => {
          finish(1)
          bs.put(block, () => {})
        }, 200)
      })
    })

    it('block is sent after local add', (done) => {
      const me = ids[0]
      const other = ids[1]
      const block = blocks[10]
      let bs1
      let bs2

      const n1 = {
        connectTo (id, cb) {
          let err
          if (id.toHexString() !== other.toHexString()) {
            err = new Error('unknown peer')
          }
          setImmediate(() => cb(err))
        },
        sendMessage (id, msg, cb) {
          if (id.toHexString() === other.toHexString()) {
            bs2._receiveMessage(me, msg, cb)
          } else {
            setImmediate(() => cb(new Error('unkown peer')))
          }
        },
        start (callback) {
          setImmediate(() => callback())
        },
        stop (callback) {
          setImmediate(() => callback())
        },
        findAndConnect (cid, callback) {
          setImmediate(() => callback())
        },
        provide (cid, callback) {
          setImmediate(() => callback())
        }
      }
      const n2 = {
        connectTo (id, cb) {
          let err
          if (id.toHexString() !== me.toHexString()) {
            err = new Error('unkown peer')
          }
          setImmediate(() => cb(err))
        },
        sendMessage (id, msg, cb) {
          if (id.toHexString() === me.toHexString()) {
            bs1._receiveMessage(other, msg, cb)
          } else {
            setImmediate(() => cb(new Error('unkown peer')))
          }
        },
        start (callback) {
          setImmediate(() => callback())
        },
        stop (callback) {
          setImmediate(() => callback())
        },
        findAndConnect (cid, callback) {
          setImmediate(() => callback())
        },
        provide (cid, callback) {
          setImmediate(() => callback())
        }
      }
      bs1 = new Bitswap(mockLibp2pNode(), repo.blocks)
      applyNetwork(bs1, n1)

      bs1.start((err) => {
        expect(err).to.not.exist()

        let repo2

        waterfall([
          (cb) => createTempRepo(cb),
          (repo, cb) => {
            repo2 = repo
            bs2 = new Bitswap(mockLibp2pNode(), repo2.blocks)
            applyNetwork(bs2, n2)
            bs2.start((err) => {
              expect(err).to.not.exist()

              bs1._onPeerConnected(other)
              bs2._onPeerConnected(me)

              bs1.get(block.cid, (err, res) => {
                expect(err).to.not.exist()
                cb(null, res)
              })
              setTimeout(() => bs2.put(block, () => {}), 1000)
            })
          },
          (res, cb) => {
            expect(res).to.eql(block)
            cb()
          }
        ], done)
      })
    })

    it('double get', (done) => {
      const block = blocks[11]

      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)

      parallel(
        [
          (cb) => bs.get(block.cid, cb),
          (cb) => bs.get(block.cid, cb)
        ],
        (err, res) => {
          expect(err).to.not.exist()
          expect(res[0]).to.eql(block)
          expect(res[1]).to.eql(block)
          done()
        }
      )

      bs.put(block, (err) => {
        expect(err).to.not.exist()
      })
    })
  })

  describe('unwant', () => {
    it('removes blocks that are wanted multiple times', (done) => {
      const bs = new Bitswap(mockLibp2pNode(), repo.blocks)
      bs.start((err) => {
        expect(err).to.not.exist()
        const b = blocks[12]

        let counter = 0
        const check = (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.not.exist()

          if (++counter === 2) { done() }
        }

        bs.get(b.cid, check)
        bs.get(b.cid, check)

        setTimeout(() => bs.unwant(b.cid), 10)
      })
    })
  })
})
