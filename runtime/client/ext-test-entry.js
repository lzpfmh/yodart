'use strict'

var logger = require('logger')('ext-app-client')

require('@yoda/oh-my-little-pony')

var translator = require('./translator-ipc')
var target = process.argv[2]
var runMode = process.argv[3]

function getActivityDescriptor (appId) {
  return new Promise((resolve, reject) => {
    process.on('message', onMessage)
    process.send({
      type: 'status-report',
      status: 'initiating',
      appId: appId
    })

    function onMessage (message) {
      if (message.type !== 'descriptor') {
        return
      }
      if (typeof message.result !== 'object') {
        process.removeListener('message', onMessage)
        return reject(new Error('Nil result on message descriptor.'))
      }
      process.removeListener('message', onMessage)
      resolve(message.result)
    }
  })
}

function launchApp (handle, activity) {
  /** start a new clean context */
  handle(activity)
}

var aliveInterval
function keepAlive (appId) {
  /**
   * FIXME: though there do have listeners on process#message,
   * ShadowNode still exits on end of current context.
   * Yet this process should be kept alive and waiting for life
   * cycle events.
   */
  aliveInterval = setInterval(() => {
    process.send({ type: 'ping' })
  }, 5 * 1000)
  process.on('message', message => {
    if (message.type === 'pong') {
      logger.info('Received pong from VuiDaemon.')
    }
  })
}

function stopAlive () {
  clearInterval(aliveInterval)
}

function test (testGlobs) {
  var tape = require('tape')
  var resolvePath = require('path').resolve
  var glob = require('tape/vendor/glob/glob-sync')

  var total = 0
  var ended = 0
  tape.createStream({ objectMode: true }).on('data', (row) => {
    logger.warn('test', row)
    switch (row.type) {
      case 'test':
        ++total
        break
      case 'end':
        ++ended
        if (ended === total) {
          // TODO: dump test result
          stopAlive()
        }
        break
      default:
    }
  })

  var cwd = process.cwd()
  testGlobs.forEach(function (arg) {
  // If glob does not match, `files` will be an empty array.
  // Note: `glob.sync` may throw an error and crash the node process.
    var files = glob(arg)

    if (!Array.isArray(files)) {
      throw new TypeError('unknown error: glob.sync did not return an array or throw. Please report this.')
    }

    files.forEach(function (file) {
      require(resolvePath(cwd, file))
    })
  })
}

var modeRunners = {
  'default': (appId) => {

  },
  test: (appId, pkg, activity) => {
    global.activity = activity
    test([ 'test/**/*.test.js' ])
  }
}

function main () {
  if (!target) {
    logger.error('Target is required.')
    process.exit(-1)
  }
  process.title = `${process.argv[0]} yoda-app ${target}`
  var pkg = require(`${target}/package.json`)
  logger.log(`load target: ${target}/package.json`)
  var appId = pkg.name
  logger = require('logger')(`entry-${appId}`)

  var main = `${target}/${pkg.main || 'app.js'}`
  var handle = require(main)
  logger.log(`load main: ${main}`)

  var runner = modeRunners[runMode]
  if (runner == null) {
    runner = modeRunners.default
  }
  logger.info('running in mode', runMode)

  keepAlive(appId)
  getActivityDescriptor(appId)
    .then(descriptor => {
      translator.setLogger(require('logger')(`@ipc-${process.pid}`))
      var activity = translator.translate(descriptor)
      activity.appHome = target

      /**
       * Executes app's main function
       */
      launchApp(handle, activity)
      runner(appId, pkg, activity)

      process.send({
        type: 'status-report',
        status: 'ready'
      })
    }).catch(error => {
      logger.error('fatal error:', error.stack)
      process.send({
        type: 'status-report',
        status: 'error',
        error: error.message,
        stack: error.stack
      })
    })
}

module.exports = main
main()

process.once('disconnect', () => {
  logger.info('IPC disconnected, exiting self.')
  process.exit(233)
})
