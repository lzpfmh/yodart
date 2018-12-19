'use strict'

var logger = require('logger')('dbgbluetooth-a2dp')
var inherits = require('util').inherits
var EventEmitter = require('events').EventEmitter
var floraFactory = require('@yoda/flora')
var FloraComp = require('@yoda/flora/comp')
var protocol = require('./protocol.json')
var AudioManager = require('@yoda/audio').AudioManager
var util = require('@yoda/util')._

/**
 * @typedef {Object} PROFILE
 * @property {string} BLE - Bluetooth low energy profile.
 * @property {string} A2DP - Bluetooth advanced audio distribution profile.
 */

/**
 * @typedef {Object} A2DP_MODE
 * @property {string} SNK - A2dp sink mode.
 * @property {string} SRC - A2dp source mode.
 */

/**
 * @typedef {Object} RADIO_STATE
 * @property {string} ON - Bluetooth radio state is ON.
 * @property {string} OFF - Bluetooth radio state is OFF.
 * @property {string} ON_FAILED - Turn on bluetooth radio failed.
 */

/**
 * @typedef {Object} CONNECTION_STATE
 * @property {string} CONNECTED - Successfully connected to remote device.
 * @property {string} DISCONNECTED - Disconnected from remote deivce.
 * @property {string} CONNECT_FAILED - Failed to connect to remote device.
 * @property {string} AUTOCONNECT_FAILED - Auto connection to history paired device failed after turn on bluetooth.
 */

/**
 * @typedef {Object} AUDIO_STATE
 * @property {string} PLAYING - Music stream is playing.
 * @property {string} PAUSED - Music stream is paused.
 * @property {string} STOPPED - Music stream is stopped.
 * @property {string} VOLUMN_CHANGED - Music stream's volumn is changed.
 */

/**
 * @typedef {Object} DISCOVERY_STATE
 * @property {string} ON - Local device is discoverable.
 * @property {string} OFF - Local device is undiscoverable.
 * @property {string} DEVICE_LIST_CHANGED - Found new around bluetooth devices.
 */

/**
 * Use `bluetooth.getAdapter(PROFILE.A2DP)` instead of this constructor.
 * @class
 * @memberof module:@yoda/bluetooth
 * @constructor
 * @param {string} deviceName - The device name of bluetooth.
 */
function BluetoothA2dp (deviceName) {
  EventEmitter.call(this)

  this.lastMsg = {
    'a2dpstate': 'closed',
    'connect_state': 'invalid',
    'connect_address': null,
    'connect_name': null,
    'play_state': 'invalid',
    'broadcast_state': 'closed',
    'linknum': 0
  }
  this._end = false
  this.lastCmd = ''
  this.lastMode = protocol.A2DP_MODE.SNK
  this.localName = deviceName
  this.unique = false

  this._flora = new FloraComp(logger)
  this._flora.handlers = {
    'bluetooth.a2dpsink.event': this._onSinkEvent.bind(this),
    'bluetooth.a2dpsource.event': this._onSourceEvent.bind(this)
  }
  this._flora.init('bluetooth-a2dp', {
    'uri': 'unix:/var/run/flora.sock',
    'bufsize': 40960,
    'reconnInterval': 10000
  })
}
inherits(BluetoothA2dp, EventEmitter)

/**
 * @private
 */
BluetoothA2dp.prototype._onSinkEvent = function (data) {
  if (this._end) {
    logger.warn('Already destroied!')
    return
  }
  try {
    var msg = JSON.parse(data[0] + '')
    logger.debug(`on sink event(action:${msg.action})`)

    if (msg.action === 'stateupdate') {
      logger.debug(`a2dp:${this.lastMsg.a2dpstate}=>${msg.a2dpstate}, conn:${this.lastMsg.connect_state}=>${msg.connect_state}, play:${this.lastMsg.play_state}=>${msg.play_state}, bc:${this.lastMsg.broadcast_state}=>${msg.broadcast_state}`)
      if (msg.a2dpstate === this.lastMsg.a2dpstate && msg.connect_state === this.lastMsg.connect_state && msg.play_state === this.lastMsg.play_state && msg.broadcast_state === this.lastMsg.broadcast_state) {
        logger.warn('Ignore last sink same msg!')
        return
      }

      if (msg.a2dpstate === 'opened' && msg.connect_state === 'invalid' && msg.play_state === 'invalid') {
        /**
         * When bluetooth's radio state is changed, such as on/off.
         * @event module:@yoda/bluetooth.BluetoothA2dp#radio_state_changed
         */
        this.emit('radio_state_changed', protocol.A2DP_MODE.SNK, protocol.RADIO_STATE.ON, {autoConn: msg.linknum > 0})
        this.unique = false
      } else if (msg.a2dpstate === 'open failed' && msg.connect_state === 'invalid' && msg.play_state === 'invalid') {
        this.emit('radio_state_changed', protocol.A2DP_MODE.SNK, protocol.RADIO_STATE.ON_FAILED)
      } else if (msg.a2dpstate === 'closed') {
        if (!this.unique) {
          this.emit('radio_state_changed', protocol.A2DP_MODE.SNK, protocol.RADIO_STATE.OFF)
        }
      } else if (msg.a2dpstate === 'opened' && msg.connect_state === 'connected') {
        if (msg.play_state === 'invalid') {
          var connectedDevice = {'address': msg.connect_address, 'name': msg.connect_name}
          /**
           * When bluetooth's connection state is changed, such as connected/disconnected.
           * @event module:@yoda/bluetooth.BluetoothA2dp#connection_state_changed
           */
          this.emit('connection_state_changed', protocol.A2DP_MODE.SNK, protocol.CONNECTION_STATE.CONNECTED, connectedDevice)
        } else if (msg.play_state === 'played') {
          /**
           * When bluetooth's audio stream state is changed, such as playing/paused.
           * @event module:@yoda/bluetooth.BluetoothA2dp#audio_state_changed
           */
          this.emit('audio_state_changed', protocol.A2DP_MODE.SNK, protocol.AUDIO_STATE.PLAYING)
        } else if (msg.play_state === 'stopped') {
          if (this.lastCmd === 'pause') {
            this.emit('audio_state_changed', protocol.A2DP_MODE.SNK, protocol.AUDIO_STATE.PAUSED)
          } else {
            this.emit('audio_state_changed', protocol.A2DP_MODE.SNK, protocol.AUDIO_STATE.STOPPED)
          }
          this.lastCmd = null
        }
      } else if (msg.a2dpstate === 'opened' && msg.connect_state === 'disconnected') {
        if (!this.unique) {
          this.emit('connection_state_changed', protocol.A2DP_MODE.SNK, protocol.CONNECTION_STATE.DISCONNECTED)
        }
      }

      if (msg.a2dpstate === 'opened' && msg.connect_state === 'invalid' && msg.play_state === 'invalid' && msg.broadcast_state === 'opened') {
        /**
         * When bluetooth's discovery state is changed, such as undiscoverable or device list changed.
         * @event module:@yoda/bluetooth.BluetoothA2dp#discovery_state_changed
         */
        this.emit('discovery_state_changed', protocol.A2DP_MODE.SNK, protocol.DISCOVERY_STATE.ON)
      } else if (msg.broadcast_state === 'closed' && this.lastMsg.broadcast_state === 'opened') {
        this.emit('discovery_state_changed', protocol.A2DP_MODE.SNK, protocol.DISCOVERY_STATE.OFF)
      }
      this.lastMsg = Object.assign(this.lastMsg, msg)
    } else if (msg.action === 'volumechange') {
      var vol = msg.value
      if (vol === undefined) {
        vol = AudioManager.getVolume(AudioManager.STREAM_PLAYBACK)
      }
      AudioManager.setVolume(vol)
      logger.info(`Set volume ${vol} for bluetooth a2dp sink.`)
      this.emit('audio_state_changed', protocol.A2DP_MODE.SNK, protocol.AUDIO_STATE.VOLUMN_CHANGED, {volumn: vol})
    }
  } catch (err) {
    logger.error(`on a2dpSinkEvent error(${JSON.stringify(err)})`)
  }
}

/**
 * @private
 */
BluetoothA2dp.prototype._onSourceEvent = function (data) {
  try {
    var msg = JSON.parse(data[0] + '')
    logger.debug(`on source event(action:${msg.action})`)

    if (msg.action === 'stateupdate') {
      logger.debug(`a2dp:${this.lastMsg.a2dpstate}=>${msg.a2dpstate}, conn:${this.lastMsg.connect_state}=>${msg.connect_state}, bc:${this.lastMsg.broadcast_state}=>${msg.broadcast_state}`)
      if (msg.a2dpstate === this.lastMsg.a2dpstate && msg.connect_state === this.lastMsg.connect_state && msg.broadcast_state === this.lastMsg.broadcast_state) {
        logger.warn('Ignore last source same msg!')
        return
      }

      if (msg.a2dpstate === 'opened' && msg.connect_state === 'invalid') {
        this.emit('radio_state_changed', protocol.A2DP_MODE.SRC, protocol.RADIO_STATE.ON, {autoConn: msg.linknum > 0})
        this.unique = false
      } else if (msg.a2dpstate === 'open failed' && msg.connect_state === 'invalid') {
        this.emit('radio_state_changed', protocol.A2DP_MODE.SRC, protocol.RADIO_STATE.ON_FAILED)
      } else if (msg.a2dpstate === 'closed') {
        if (!this.unique) {
          this.emit('radio_state_changed', protocol.A2DP_MODE.SRC, protocol.RADIO_STATE.OFF)
        }
      } else if (msg.a2dpstate === 'opened' && msg.connect_state === 'connected') {
        var connectedDevice = {'address': msg.connect_address, 'name': msg.connect_name}
        this.emit('connection_state_changed', protocol.A2DP_MODE.SRC, protocol.CONNECTION_STATE.CONNECTED, connectedDevice)
      } else if (msg.a2dpstate === 'opened' && msg.connect_state === 'disconnected') {
        if (!this.unique) {
          this.emit('connection_state_changed', protocol.A2DP_MODE.SRC, protocol.CONNECTION_STATE.DISCONNECTED)
        }
      } else if (msg.a2dpstate === 'opened' && msg.connect_state === 'connect failed') {
        this.emit('connection_state_changed', protocol.A2DP_MODE.SRC, protocol.CONNECTION_STATE.CONNECT_FAILED)
      } else if (msg.a2dpstate === 'opened' && msg.connect_state === 'connect over') {
        this.emit('connection_state_changed', protocol.A2DP_MODE.SRC, protocol.CONNECTION_STATE.AUTOCONNECT_FAILED)
      }
      this.lastMsg = Object.assign(this.lastMsg, msg)
    } else if (msg.action === 'discovery') {
      var results = msg.results
      var nbr = results.deviceList != null ? results.deviceList.length : 0
      logger.debug(`Found ${nbr} devices, is_comp: ${results.is_completed}, currentDevice: ${results.currentDevice}`)
      for (var i = 0; i < nbr; i++) {
        logger.debug(`  ${results.deviceList[i].name} : ${results.deviceList[i].address}`)
      }
      this.emit('discovery_state_changed', protocol.A2DP_MODE.SRC, protocol.DISCOVERY_STATE.DEVICE_LIST_CHANGED, results)
    }
  } catch (err) {
    logger.error(`on a2dpSourceEvent error(${JSON.stringify(err)})`)
  }
}

/**
 * @private
 */
BluetoothA2dp.prototype._send = function (mode, cmdstr, props) {
  var data = Object.assign({ command: cmdstr }, props || {})
  var msg = [ JSON.stringify(data) ]
  var name = (mode === protocol.A2DP_MODE.SNK ? 'bluetooth.a2dpsink.command' : 'bluetooth.a2dpsource.command')
  var type = (cmdstr === 'ON' ? floraFactory.MSGTYPE_PERSIST : floraFactory.MSGTYPE_INSTANT)
  return this._flora.post(name, msg, type)
}

/**
 * Turn on the bluetooth. It starts `a2dp-sink` or `a2dp-source` according parameters.
 *
 * You can listen following changed state events:
 * - `RADIO_STATE.ON` when bluetooth is opened successfully.
 * - `RADIO_STATE.ON_FAILED` when bluetooth cannot be opened.
 * - `CONNECTION_STATE.AUTOCONNECT_FAILED` when bluetooth opened but auto connect to history paired device failed.
 *
 * @param {A2DP_MODE} [mode] - Specify the bluetooth a2dp profile mode. If this param is not provided, will starts `A2DP_MODE.SNK` for default.
 * @param {object} [options] - The extra options.
 * @param {boolean} [options.autoplay=false] - Whether after autoconnected, music should be played automatically.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#radio_state_changed
 * @fires module:@yoda/bluetooth/BluetoothA2dp#connection_state_changed
 * @example
 * var protocol = require('@yoda/bluetooth/protocol.json')
 * var a2dp = require('@yoda/bluetooth').getAdapter(protocol.PROFILE.A2DP)
 * a2dp.on('radio_state_changed', function (mode, state, extra) {
 *   console.log(`bluetooth mode: ${mode}, state: ${state}`)
 * })
 * a2dp.open(A2DP_MODE.SNK, {autoplay: true})
 */
BluetoothA2dp.prototype.open = function open (mode, options) {
  if (mode === undefined) {
    mode = protocol.A2DP_MODE.SNK
  }
  var autoplay = util.get(options, 'autoplay', false)
  logger.debug(`open(${this.lastMode}=>${mode}, autoplay:${autoplay})`)
  if (this.lastMode !== mode && this.isOpened()) {
    this.unique = true
  }
  this.lastMode = mode
  if (autoplay) {
    return this._send(mode, 'ON', {name: this.localName, unique: true, subsequent: 'PLAY'})
  } else {
    return this._send(mode, 'ON', {name: this.localName, unique: true})
  }
}

/**
 * Turn off the bluetooth.
 *
 * You can listen following changed state events:
 * - `RADIO_STATE.OFF` when bluetooth is closed.
 *
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#radio_state_changed
 */
BluetoothA2dp.prototype.close = function close () {
  logger.debug(`close(${this.lastMode}, ${this.lastMsg.a2dpstate})`)
  if (this.lastMsg.a2dpstate === 'closed') {
    logger.warn('close() while last state is already closed.')
  }
  return this._send(this.lastMode, 'OFF')
}

/**
 * Connect bluetooth to another remote device.
 *
 * You can listen following changed state events:
 * - `CONNECTION_STATE.CONNECTED` when successfully connected to another device.
 * - `CONNECTION_STATE.CONNECT_FAILED` when cannot connect to another device.
 * @param {string} addr - Specify the target bluetooth device's MAC address.
 * @param {string} name - Specify the target bluetooth device's name.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#connection_state_changed
 */
BluetoothA2dp.prototype.connect = function connect (addr, name) {
  logger.debug(`connect(${this.lastMode}, ${name}:${addr})`)
  if (this.lastMode === protocol.A2DP_MODE.SRC) {
    var target = {'address': addr, 'name': name}
    if (this.lastMsg.a2dpstate !== 'opened') {
      logger.warn('connect() while last state is not opened.')
    }
    if (this.lastMsg.connect_state === 'connected' && this.lastMsg.connect_address === addr) {
      logger.warn('connect() to same device?')
    }
    return this._send(this.lastMode, 'CONNECT', target)
  } else {
    logger.warn('connect() is not supported for SINK!')
    process.nextTick(() => {
      return this.emit(protocol.STATE_CHANGED.CONNECTION, this.lastMode, protocol.CONNECTION_STATE.CONNECT_FAILED)
    })
  }
}

/**
 * Disconnect bluetooth from another remote device.
 *
 * You can listen following changed state event:
 * - `CONNECTION_STATE.DISCONNECTED` after disconnected from another device.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#connection_state_changed
 */
BluetoothA2dp.prototype.disconnect = function disconnect () {
  logger.debug(`disconnect(${this.lastMode})`)
  if (this.lastMsg.connect_state !== 'connected') {
    logger.warn('disconnect() while last state is not connected.')
  }
  return this._send(this.lastMode, 'DISCONNECT_PEER')
}

/**
 * Mute music stream.
 *
 *  No state changed after this command execution.
 * @returns {null}
 */
BluetoothA2dp.prototype.mute = function mute () {
  logger.debug(`mute(${this.lastMode})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    return this._send(this.lastMode, 'MUTE')
  } else {
    return false
  }
}

/**
 * Unmute music stream.
 *
 * No state changed after this command execution.
 * @returns {null}
 */
BluetoothA2dp.prototype.unmute = function unmute () {
  logger.debug(`unmute(${this.lastMode})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    return this._send(this.lastMode, 'UNMUTE')
  } else {
    return false
  }
}

/**
 * Play music stream.
 *
 * You can listen following changed state event:
 * - `AUDIO_STATE.PLAYING` after music play started.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#audio_state_changed
 */
BluetoothA2dp.prototype.play = function play () {
  logger.debug(`play(${this.lastMode}, play_state: ${this.lastMsg.play_state})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    if (this.lastMsg.play_state === 'played') {
      logger.warn('play() while last state is already played.')
    }
    this.unmute()
    return this._send(this.lastMode, 'PLAY')
  } else {
    return false
  }
}

/**
 * Pause music stream.
 *
 * You can listen following changed state event:
 * - `AUDIO_STATE.PAUSED` after music play paused.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#audio_state_changed
 */
BluetoothA2dp.prototype.pause = function pause () {
  logger.debug(`pause(${this.lastMode}, play_state: ${this.lastMsg.play_state})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    if (this.lastMsg.play_state === 'stopped') {
      logger.warn('pause() while last state is already stopped.')
    }
    this.lastCmd = 'pause'
    return this._send(this.lastMode, 'PAUSE')
  } else {
    return false
  }
}

/**
 * Stop music stream.
 *
 * You can listen following changed state event:
 * - `AUDIO_STATE.STOPPED` after music play stopped.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#audio_state_changed
 */
BluetoothA2dp.prototype.stop = function stop () {
  logger.debug(`stop(${this.lastMode}, play_state: ${this.lastMsg.play_state})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    if (this.lastMsg.play_state === 'stopped') {
      logger.warn('stop() while last state is already stopped.')
    }
    this.lastCmd = 'stop'
    return this._send(this.lastMode, 'STOP')
  } else {
    return false
  }
}

/**
 * Play previous song.
 *
 * No state changed after this command execution.
 * @returns {null}
 */
BluetoothA2dp.prototype.prev = function prev () {
  logger.debug(`prev(${this.lastMode})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    return this._send(this.lastMode, 'PREV')
  } else {
    return false
  }
}

/**
 * Play next song.
 *
 * No state changed after this command execution.
 * @returns {null}
 */
BluetoothA2dp.prototype.next = function next () {
  logger.debug(`next(${this.lastMode})`)
  if (this.lastMode === protocol.A2DP_MODE.SNK) {
    return this._send(this.lastMode, 'NEXT')
  } else {
    return false
  }
}

/**
 * Set local device discoverable.
 *
 * You can listen following changed state event:
 * - `DISCOVER_STATE.ON` after set succeeded.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#discovery_state_changed
 */
BluetoothA2dp.prototype.setDiscoverable = function setDiscoverable () {
  logger.debug('Todo: not implemenet yet.')
  return false
}

/**
 * Set local device undiscoverable.
 *
 * You can listen following changed state event:
 * - `DISCOVER_STATE.OFF` after set succeeded.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#discovery_state_changed
 */
BluetoothA2dp.prototype.setUndiscoverable = function setUndiscoverable () {
  logger.debug('Todo: not implemenet yet.')
  return false
}

/**
 * Discovery around bluetooth devices.
 *
 * You can listen following changed state event:
 * - `DISCOVER_STATE.DEVICE_LIST_CHANGED` while some bluetooth devices have been found.
 * @returns {null}
 * @fires module:@yoda/bluetooth/BluetoothA2dp#discovery_state_changed
 */
BluetoothA2dp.prototype.discovery = function discovery () {
  logger.debug(`discovery(${this.lastMode}, cur state: ${this.lastMsg.a2dpstate})`)
  if (this.lastMode === protocol.A2DP_MODE.SRC) {
    if (this.lastMsg.a2dpstate !== 'opened') {
      logger.warn('discovery() while last state is not opened.')
    }
    return this._send(this.lastMode, 'DISCOVERY')
  } else {
    return false
  }
}

/**
 * Get current running A2DP profile mode.
 * @returns {A2DP_MODE} - The current running A2DP profile mode.
 */
BluetoothA2dp.prototype.getMode = function getMode () {
  return this.lastMode
}

/**
 * Get if bluetooth is opened.
 * @returns {boolean} - `true` if bluetooth is opened else `false`.
 */
BluetoothA2dp.prototype.isOpened = function isOpened () {
  return this.lastMsg.a2dpstate === 'opened'
}

/**
 * Get if this device is connected with another bluetooth device.
 * @returns {boolean} - `true` if blueooth is connected with another device else `false`.
 */
BluetoothA2dp.prototype.isConnected = function isConnected () {
  return this.lastMsg.connect_state === 'connected'
}

/**
 * @typedef {Object} BluetoothDevice
 * @property {string} name - The device's name.
 * @property {string} address - The device's MAC address.
 */

/**
 * Get connected bluetooth device.
 * @returns {BluetoothDevice} - Current connected bluetooth device object or `null` if no connected device.
 */
BluetoothA2dp.prototype.getConnectedDevice = function getConnectedDevice () {
  if (!this.isConnected()) {
    return null
  } else {
    return {
      address: this.lastMsg.connect_address,
      name: this.lastMsg.connect_name
    }
  }
}

/**
 * Get if bluetooth music is playing.
 * @returns {boolean} - `true` if bluetooth music is playing else `false`.
 */
BluetoothA2dp.prototype.isPlaying = function isPlaying () {
  return this.lastMsg.play_state === 'played'
}

/**
 * Get if this deivce is under discoverable.
 * @returns {boolean} - `true` if local device is under discoverable else `false`.
 */
BluetoothA2dp.prototype.isDiscoverable = function isDiscoverable () {
  return this.lastMsg.broadcast_state === 'opened'
}

/**
 * Destroy bluetooth profile adapter, thus means bluetooth will be turned `OFF` automatically always.
 */
BluetoothA2dp.prototype.destroy = function destroy () {
  var destroyFunc = function () {
    this.removeAllListeners()
    this._flora.destruct()
    this._end = true
  }.bind(this)
  this.close()
  setTimeout(destroyFunc, 2000)
}

exports.BluetoothA2dp = BluetoothA2dp
