/* eslint max-nested-callbacks: ["error", 8] */
/* eslint-env mocha */
'use strict'

const expect = require('chai').expect
const PeerId = require('peer-id')
const _ = require('lodash')
const Block = require('ipfs-block')
const parallel = require('async/parallel')
const series = require('async/series')
const map = require('async/map')
const eachSeries = require('async/eachSeries')
const pull = require('pull-stream')
const paramap = require('pull-paramap')

const Message = require('../../src/message')
const Engine = require('../../src/decision/engine')

const mockNetwork = require('../utils').mockNetwork

module.exports = (repo) => {
  function newEngine (id, done) {
    parallel([
      (cb) => repo.create(id, cb),
      (cb) => PeerId.create(cb)
    ], (err, results) => {
      if (err) {
        return done(err)
      }
      const blockstore = results[0].blockstore
      const engine = new Engine(blockstore, mockNetwork())
      engine.start()

      done(null, {
        peer: results[1],
        engine
      })
    })
  }

  describe('Engine', () => {
    afterEach((done) => {
      repo.remove(done)
    })

    it('consistent accounting', (done) => {
      parallel([
        (cb) => newEngine('Ernie', cb),
        (cb) => newEngine('Bert', cb)
      ], (err, res) => {
        expect(err).to.not.exist

        const sender = res[0]
        const receiver = res[1]

        pull(
          pull.values(_.range(1000)),
          pull.map((i) => {
            const content = `this is message ${i}`
            return new Block(content)
          }),
          paramap((block, cb) => {
            const m = new Message(false)
            m.addBlock(block, (err) => {
              if (err) {
                return cb(err)
              }
              block.key((err, key) => {
                if (err) {
                  return cb(err)
                }
                sender.engine.messageSent(receiver.peer, block, key)
                receiver.engine.messageReceived(sender.peer, m, cb)
              })
            })
          }, 100),
          pull.onEnd((err) => {
            expect(err).to.not.exist

            expect(
              sender.engine.numBytesSentTo(receiver.peer)
            ).to.be.above(
              0
            )

            expect(
              sender.engine.numBytesSentTo(receiver.peer)
            ).to.be.eql(
              receiver.engine.numBytesReceivedFrom(sender.peer)
            )

            expect(
              receiver.engine.numBytesSentTo(sender.peer)
            ).to.be.eql(
              0
            )

            expect(
              sender.engine.numBytesReceivedFrom(receiver.peer)
            ).to.be.eql(
              0
            )

            done()
          })
        )
      })
    })

    it('peer is added to peers when message receiver or sent', (done) => {
      parallel([
        (cb) => newEngine('sf', cb),
        (cb) => newEngine('sea', cb)
      ], (err, res) => {
        expect(err).to.not.exist

        const sanfrancisco = res[0]
        const seatlle = res[1]

        const m = new Message(true)
        sanfrancisco.engine.messageSent(seatlle.peer)
        seatlle.engine.messageReceived(sanfrancisco.peer, m, (err) => {
          expect(err).to.not.exist

          expect(
            seatlle.peer.toHexString()
          ).to.not.be.eql(
            sanfrancisco.peer.toHexString()
          )

          expect(
            sanfrancisco.engine.peers()
          ).to.include(
            seatlle.peer
          )

          expect(
            seatlle.engine.peers()
          ).to.include(
            sanfrancisco.peer
          )
          done()
        })
      })
    })

    it('partner wants then cancels', (done) => {
      const numRounds = 10
      const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('')
      const vowels = 'aeiou'.split('')
      const testCases = [
        [alphabet, vowels],
        [alphabet, _.difference(alphabet, vowels)]
      ]

      repo.create('p', (err, repo) => {
        expect(err).to.not.exist

        pull(
          pull.values(alphabet),
          pull.asyncMap((l, cb) => {
            const block = new Block(l)
            block.key((err, key) => {
              if (err) {
                return cb(err)
              }
              cb(null, {data: block.data, key: key})
            })
          }),
          repo.blockstore.putStream(),
          pull.onEnd((err) => {
            expect(err).to.not.exist

            const partnerWants = (e, keys, p, cb) => {
              const add = new Message(false)
              const blocks = keys.map((k) => new Block(k))
              map(blocks, (b, cb) => b.key(cb), (err, keys) => {
                expect(err).to.not.exist
                blocks.forEach((b, i) => {
                  add.addEntry(keys[i], Math.pow(2, 32) - 1 - i)
                })

                e.messageReceived(p, add, cb)
              })
            }

            const partnerCancels = (e, keys, p, cb) => {
              const cancels = new Message(false)
              const blocks = keys.map((k) => new Block(k))
              map(blocks, (b, cb) => b.key(cb), (err, keys) => {
                expect(err).to.not.exist
                keys.forEach((k) => cancels.cancel(k))
                e.messageReceived(p, cancels, cb)
              })
            }

            eachSeries(_.range(numRounds), (i, cb) => {
              eachSeries(testCases, (testcase, innerCb) => {
                const set = testcase[0]
                const cancels = testcase[1]
                const keeps = _.difference(set, cancels)

                const messageToString = (m) => {
                  return Array.from(m[1].blocks.values())
                    .map((b) => b.data.toString())
                }
                const stringifyMessages = (messages) => {
                  return _.flatten(messages.map(messageToString))
                }

                const network = mockNetwork(1, (res) => {
                  const msgs = stringifyMessages(res.messages)
                  expect(msgs.sort()).to.be.eql(keeps.sort())
                  innerCb()
                })

                const e = new Engine(repo.blockstore, network)
                e.start()
                let partner
                series([
                  (cb) => PeerId.create((err, id) => {
                    if (err) {
                      return cb(err)
                    }
                    partner = id
                    cb()
                  }),
                  (cb) => partnerWants(e, set, partner, cb),
                  (cb) => partnerCancels(e, cancels, partner, cb)
                ], (err) => {
                  if (err) throw err
                })
              }, cb)
            }, done)
          })
        )
      })
    })
  })
}
