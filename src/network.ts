import * as lp from 'it-length-prefixed'
import { pipe } from 'it-pipe'
import { createTopology } from '@libp2p/topology'
import { BitswapMessage as Message } from './message/index.js'
import * as CONSTANTS from './constants.js'
import { logger } from './utils/index.js'
import { TimeoutController } from 'timeout-abort-controller'
import { abortableSource } from 'abortable-iterator'
import type { Libp2p } from '@libp2p/interface-libp2p'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { MultihashHasherLoader } from './index.js'
import type { DefaultBitswap } from './bitswap.js'
import type { Stats } from './stats/index.js'
import type { Logger } from '@libp2p/logger'
import type { IncomingStreamData } from '@libp2p/interface-registrar'
import type { CID } from 'multiformats/cid'
import type { AbortOptions } from '@libp2p/interfaces'
import type { Connection, Stream } from '@libp2p/interface-connection'
import type { PeerInfo } from '@libp2p/interface-peer-info'

export interface Provider {
  id: PeerId
  multiaddrs: Multiaddr[]
}

const BITSWAP100 = '/ipfs/bitswap/1.0.0'
const BITSWAP110 = '/ipfs/bitswap/1.1.0'
const BITSWAP120 = '/ipfs/bitswap/1.2.0'

const DEFAULT_MAX_INBOUND_STREAMS = 32
const DEFAULT_MAX_OUTBOUND_STREAMS = 128
const DEFAULT_INCOMING_STREAM_TIMEOUT = 30000

export interface NetworkOptions {
  b100Only?: boolean
  hashLoader?: MultihashHasherLoader
  maxInboundStreams?: number
  maxOutboundStreams?: number
  incomingStreamTimeout?: number
}

export class Network {
  private readonly _log: Logger
  private readonly _libp2p: Libp2p
  private readonly _bitswap: DefaultBitswap
  public _protocols: string[]
  private readonly _stats: Stats
  private _running: boolean
  private readonly _hashLoader: MultihashHasherLoader
  private readonly _maxInboundStreams: number
  private readonly _maxOutboundStreams: number
  private readonly _incomingStreamTimeout: number
  private _registrarIds?: string[]

  constructor (libp2p: Libp2p, bitswap: DefaultBitswap, stats: Stats, options: NetworkOptions = {}) {
    this._log = logger(libp2p.peerId, 'network')
    this._libp2p = libp2p
    this._bitswap = bitswap
    this._protocols = [BITSWAP100]

    if (options.b100Only !== true) {
      // Latest bitswap first
      this._protocols.unshift(BITSWAP110)
      this._protocols.unshift(BITSWAP120)
    }

    this._stats = stats
    this._running = false

    // bind event listeners
    this._onPeerConnect = this._onPeerConnect.bind(this)
    this._onPeerDisconnect = this._onPeerDisconnect.bind(this)
    this._onConnection = this._onConnection.bind(this)
    this._hashLoader = options.hashLoader ?? {
      async getHasher () {
        throw new Error('Not implemented')
      }
    }
    this._maxInboundStreams = options.maxInboundStreams ?? DEFAULT_MAX_INBOUND_STREAMS
    this._maxOutboundStreams = options.maxOutboundStreams ?? DEFAULT_MAX_OUTBOUND_STREAMS
    this._incomingStreamTimeout = options.incomingStreamTimeout ?? DEFAULT_INCOMING_STREAM_TIMEOUT
  }

  async start (): Promise<void> {
    this._running = true
    await this._libp2p.handle(this._protocols, this._onConnection, {
      maxInboundStreams: this._maxInboundStreams,
      maxOutboundStreams: this._maxOutboundStreams
    })

    // register protocol with topology
    const topology = createTopology({
      onConnect: this._onPeerConnect,
      onDisconnect: this._onPeerDisconnect
    })

    /** @type {string[]} */
    this._registrarIds = []

    for (const protocol of this._protocols) {
      this._registrarIds.push(await this._libp2p.register(protocol, topology))
    }

    // All existing connections are like new ones for us
    this._libp2p.getConnections().forEach(conn => {
      this._onPeerConnect(conn.remotePeer)
    })
  }

  async stop (): Promise<void> {
    this._running = false

    // Unhandle both, libp2p doesn't care if it's not already handled
    await this._libp2p.unhandle(this._protocols)

    // unregister protocol and handlers
    if (this._registrarIds != null) {
      for (const id of this._registrarIds) {
        this._libp2p.unregister(id)
      }

      this._registrarIds = []
    }
  }

  /**
   * Handles both types of incoming bitswap messages
   */
  _onConnection (info: IncomingStreamData): void {
    if (!this._running) {
      return
    }

    const { stream, connection } = info
    const controller = new TimeoutController(this._incomingStreamTimeout)

    Promise.resolve().then(async () => {
      this._log('incoming new bitswap %s connection from %p', stream.stat.protocol, connection.remotePeer)

      await pipe(
        abortableSource(stream.source, controller.signal),
        lp.decode(),
        async (source) => {
          for await (const data of source) {
            try {
              const message = await Message.deserialize(data.subarray(), this._hashLoader)
              await this._bitswap._receiveMessage(connection.remotePeer, message)
            } catch (err: any) {
              this._bitswap._receiveError(err)
              break
            }

            // we have received some data so reset the timeout controller
            controller.reset()
          }
        }
      )
    })
      .catch(err => {
        this._log(err)
        stream.abort(err)
      })
      .finally(() => {
        controller.clear()
        stream.close()
      })
  }

  _onPeerConnect (peerId: PeerId): void {
    this._bitswap._onPeerConnected(peerId)
  }

  _onPeerDisconnect (peerId: PeerId): void {
    this._bitswap._onPeerDisconnected(peerId)
  }

  /**
   * Find providers given a `cid`.
   */
  findProviders (cid: CID, options: AbortOptions = {}): AsyncIterable<PeerInfo> {
    return this._libp2p.contentRouting.findProviders(cid, options)
  }

  /**
   * Find the providers of a given `cid` and connect to them.
   */
  async findAndConnect (cid: CID, options?: AbortOptions): Promise<void> {
    const connectAttempts = []
    let found = 0

    for await (const provider of this.findProviders(cid, options)) {
      this._log(`connecting to provider ${provider.id}`)
      connectAttempts.push(
        this.connectTo(provider.id, options)
          .catch(err => {
            // Prevent unhandled promise rejection
            this._log.error(err)
          })
      )

      found++

      if (found === CONSTANTS.maxProvidersPerRequest) {
        break
      }
    }

    await Promise.all(connectAttempts)
  }

  /**
   * Tell the network we can provide content for the passed CID
   */
  async provide (cid: CID, options?: AbortOptions): Promise<void> {
    await this._libp2p.contentRouting.provide(cid, options)
  }

  /**
   * Connect to the given peer
   * Send the given msg (instance of Message) to the given peer
   */
  async sendMessage (peer: PeerId, msg: Message): Promise<void> {
    if (!this._running) throw new Error('network isn\'t running')

    const stringId = peer.toString()
    this._log('sendMessage to %s', stringId, msg)

    const connection = await this._libp2p.dial(peer)
    const stream = await connection.newStream([BITSWAP120, BITSWAP110, BITSWAP100])

    await writeMessage(stream, msg, this._log)

    this._updateSentStats(peer, msg.blocks)
  }

  /**
   * Connects to another peer
   */
  async connectTo (peer: PeerId | Multiaddr, options?: AbortOptions): Promise<Connection> { // eslint-disable-line require-await
    if (!this._running) {
      throw new Error('network isn\'t running')
    }

    return await this._libp2p.dial(peer, options)
  }

  _updateSentStats (peer: PeerId, blocks: Map<string, Uint8Array>): void {
    const peerId = peer.toString()

    if (this._stats != null) {
      for (const block of blocks.values()) {
        this._stats.push(peerId, 'dataSent', block.length)
      }

      this._stats.push(peerId, 'blocksSent', blocks.size)
    }
  }
}

async function writeMessage (stream: Stream, msg: Message, log: Logger): Promise<void> {
  try {
    /** @type {Uint8Array} */
    let serialized
    switch (stream.stat.protocol) {
      case BITSWAP100:
        serialized = msg.serializeToBitswap100()
        break
      case BITSWAP110:
      case BITSWAP120:
        serialized = msg.serializeToBitswap110()
        break
      default:
        throw new Error(`Unknown protocol: ${stream.stat.protocol}`)
    }

    await pipe(
      [serialized],
      lp.encode(),
      stream
    )
  } catch (err) {
    log(err)
  } finally {
    stream.close()
  }
}
