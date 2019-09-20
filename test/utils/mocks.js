'use strict'

const range = require('lodash.range')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const PeerBook = require('peer-book')
const Node = require('./create-libp2p-node').bundle
const os = require('os')
const Repo = require('ipfs-repo')
const EventEmitter = require('events')
const promisify = require('promisify-es6')

const Bitswap = require('../../src')

/*
 * Create a mock libp2p node
 */
exports.mockLibp2pNode = () => {
  const peerInfo = new PeerInfo(PeerId.createFromHexString('122019318b6e5e0cf93a2314bf01269a2cc23cd3dcd452d742cdb9379d8646f6e4a9'))

  return Object.assign(new EventEmitter(), {
    peerInfo: peerInfo,
    handle () {},
    unhandle () {},
    contentRouting: {
      provide: async (cid) => {}, // eslint-disable-line require-await
      findProviders: async (cid, timeout) => { return [] } // eslint-disable-line require-await
    },
    on () {},
    async  dial (peer) { // eslint-disable-line require-await
    },
    async dialProtocol (peer, protocol) { // eslint-disable-line require-await

    },
    swarm: {
      setMaxListeners () {}
    },
    peerBook: new PeerBook()
  })
}

/*
 * Create a mock network instance
 */
exports.mockNetwork = (calls, done) => {
  done = done || (() => {})

  const connects = []
  const messages = []
  let i = 0

  const finish = () => {
    if (++i === calls) {
      done({ connects: connects, messages: messages })
    }
  }

  return {
    connectTo (p) {
      setImmediate(() => {
        connects.push(p)
      })
    },
    sendMessage (p, msg) {
      messages.push([p, msg])

      setImmediate(() => {
        finish()
      })

      return Promise.resolve()
    },
    start () {
      return Promise.resolve()
    },
    findAndConnect () {
      return Promise.resolve()
    },
    provide () {
      return Promise.resolve()
    }
  }
}

/*
 * Create a mock test network
 */
exports.createMockTestNet = async (repo, count) => {
  const results = await Promise.all([
    range(count).map((i) => repo.create(`repo-${i}`)),
    range(count).map((i) => promisify(PeerId.create)({ bits: 512 }))
  ])

  const stores = results[0].map((r) => r.blockstore)
  const ids = results[1]

  const hexIds = ids.map((id) => id.toHexString())
  const bitswaps = range(count).map((i) => new Bitswap({}, stores[i]))
  const networks = range(count).map((i) => {
    return {
      connectTo (id) {
        return new Promise((resolve, reject) => {
          if (!hexIds.includes(hexIds, id.toHexString())) {
            return reject(new Error('unkown peer'))
          }
          resolve()
        })
      },
      sendMessage (id, msg) {
        const j = hexIds.findIndex((el) => el === id.toHexString())
        return bitswaps[j]._receiveMessage(ids[i], msg)
      },
      start () {
      }
    }
  })

  range(count).forEach((i) => {
    exports.applyNetwork(bitswaps[i], networks[i])
    bitswaps[i].start()
  })

  return {
    ids,
    stores,
    bitswaps,
    networks
  }
}

exports.applyNetwork = (bs, n) => {
  bs.network = n
  bs.wm.network = n
  bs.engine.network = n
}

let basePort = 12000

exports.genBitswapNetwork = async (n) => {
  const netArray = [] // bitswap, peerBook, libp2p, peerInfo, repo

  // create PeerInfo and libp2p.Node for each
  const peers = await Promise.all(
    range(n).map(i => promisify(PeerInfo.create)())
  )

  peers.forEach((p, i) => {
    basePort++
    p.multiaddrs.add('/ip4/127.0.0.1/tcp/' + basePort + '/ipfs/' + p.id.toB58String())

    const l = new Node({ peerInfo: p })
    netArray.push({ peerInfo: p, libp2p: l })
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
    net.repo = new Repo(repoPath)
  })

  await Promise.all(
    netArray.map(async (net) => {
      const repoPath = tmpDir + '/' + net.peerInfo.id.toB58String()
      net.repo = new Repo(repoPath)

      await net.repo.init({})
      await net.repo.open()
    })
  )

  // start every libp2pNode
  await Promise.all(
    netArray.map((net) => net.libp2p.start())
  )

  // create every BitSwap
  netArray.forEach((net) => {
    net.bitswap = new Bitswap(net.libp2p, net.repo.blocks, net.peerBook)
  })

  // connect all the nodes between each other
  for (const from of netArray) {
    for (const to of netArray) {
      if (from.peerInfo.id.toB58String() !== to.peerInfo.id.toB58String()) {
        await from.libp2p.dial(to.peerInfo)
      }
    }
  }

  return netArray
}
