'use strict'

const each = require('async/each')
const eachSeries = require('async/eachSeries')
const map = require('async/map')
const parallel = require('async/parallel')
const _ = require('lodash')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
// const PeerBook = require('peer-book')
const multiaddr = require('multiaddr')
const Bitswap = require('../src')
const Node = require('libp2p-ipfs-nodejs')
const os = require('os')
const Repo = require('ipfs-repo')
const Store = require('interface-pull-blob-store')

exports.mockNetwork = (calls, done) => {
  done = done || (() => {})
  const connects = []
  const messages = []
  let i = 0

  const finish = () => {
    i++
    if (i === calls) {
      done({connects, messages})
    }
  }

  return {
    connectTo (p, cb) {
      setImmediate(() => {
        connects.push(p)
        cb()
      })
    },
    sendMessage (p, msg, cb) {
      setImmediate(() => {
        messages.push([p, msg])
        cb()
        finish()
      })
    },
    start () {
    }
  }
}

exports.createMockNet = (repo, count, cb) => {
  parallel([
    (cb) => map(_.range(count), (i, cb) => repo.create(`repo-${i}`), cb),
    (cb) => map(_.range(count), (i, cb) => PeerId.create(cb), cb)
  ], (err, results) => {
    if (err) {
      return cb(err)
    }
    const stores = results[0].map((r) => r.blockstore)
    const ids = results[1]

    const hexIds = ids.map((id) => id.toHexString())
    const bitswaps = _.range(count).map((i) => new Bitswap(ids[i], {}, stores[i]))
    const networks = _.range(count).map((i) => {
      return {
        connectTo (id, cb) {
          const done = (err) => setImmediate(() => cb(err))
          if (!_.includes(hexIds, id.toHexString())) {
            return done(new Error('unkown peer'))
          }
          done()
        },
        sendMessage (id, msg, cb) {
          const j = _.findIndex(hexIds, (el) => el === id.toHexString())
          bitswaps[j]._receiveMessage(ids[i], msg, cb)
        },
        start () {
        }
      }
    })

    _.range(count).forEach((i) => {
      exports.applyNetwork(bitswaps[i], networks[i])
      bitswaps[i].start()
    })

    cb(null, {
      ids,
      stores,
      bitswaps,
      networks
    })
  })
}

exports.applyNetwork = (bs, n) => {
  bs.network = n
  bs.wm.network = n
  bs.engine.network = n
}

exports.genBitswapNetwork = (n, callback) => {
  const netArray = [] // bitswap, peerBook, libp2p, peerInfo, repo
  const basePort = 12000

  // create PeerInfo and libp2p.Node for each
  map(_.range(n), (i, cb) => PeerInfo.create(cb), (err, peers) => {
    if (err) {
      return callback(err)
    }

    peers.forEach((p, i) => {
      const mh1 = multiaddr('/ip4/127.0.0.1/tcp/' + (basePort + i) +
                            '/ipfs/' + p.id.toB58String())
      p.multiaddr.add(mh1)

      // const mh2 = multiaddr('/ip4/127.0.0.1/tcp/' + (basePort + i + 2000) + '/ws' +
      //                       '/ipfs/' + p.id.toB58String())
      // p.multiaddr.add(mh2)

      const l = new Node(p)
      netArray.push({peerInfo: p, libp2p: l})
    })

    // create PeerBook and populate peerBook
    netArray.forEach((net, i) => {
      const pb = netArray[i].libp2p.peerBook
      netArray.forEach((net, j) => {
        if (i === j) {
          return
        }
        pb.put(net.peerInfo)
      })
      netArray[i].peerBook = pb
    })

    // create the repos
    const tmpDir = os.tmpdir()
    netArray.forEach((net, i) => {
      const repoPath = tmpDir + '/' + net.peerInfo.id.toB58String()
      net.repo = new Repo(repoPath, { stores: Store })
    })

    // start every libp2pNode
    each(netArray, (net, cb) => {
      net.libp2p.start(cb)
    }, (err) => {
      if (err) {
        throw err
      }
      createBitswaps()
    })

    // create every BitSwap
    function createBitswaps () {
      netArray.forEach((net) => {
        net.bitswap = new Bitswap(net.peerInfo, net.libp2p, net.repo.blockstore, net.peerBook)
      })
      establishLinks()
    }

    // connect all the nodes between each other
    function establishLinks () {
      eachSeries(netArray, (from, cbI) => {
        eachSeries(netArray, (to, cbJ) => {
          if (from.peerInfo.id.toB58String() ===
              to.peerInfo.id.toB58String()) {
            return cbJ()
          }

          from.libp2p.dialByPeerInfo(to.peerInfo, cbJ)
        }, cbI)
      }, finish)
    }

    // callback with netArray
    function finish (err) {
      if (err) {
        throw err
      }
      callback(null, netArray)
    }
  })
}
