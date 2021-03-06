const ecc = require('enujs-ecc')
const Fcbuffer = require('fcbuffer')
const EnuApi = require('enujs-api')
const assert = require('assert')

const Structs = require('./structs')
const AbiCache = require('./abi-cache')
const writeApiGen = require('./write-api')
const format = require('./format')
const schema = require('./schema')

const token = require('./schema/enu.token.abi.json')
const system = require('./schema/enu.system.abi.json')
const enumivo_null = require('./schema/enumivo.null.abi.json')

const Enu = (config = {}) => {
  const configDefaults = {
    httpEndpoint: 'http://127.0.0.1:8888',
    debug: false,
    verbose: false,
    broadcast: true,
    logger: {
      log: (...args) => config.verbose ? console.log(...args) : null,
      error: (...args) => config.verbose ? console.error(...args) : null
    },
    sign: true
  }

  function applyDefaults(target, defaults) {
    Object.keys(defaults).forEach(key => {
      if(target[key] === undefined) {
        target[key] = defaults[key]
      }
    })
  }

  applyDefaults(config, configDefaults)
  applyDefaults(config.logger, configDefaults.logger)
  return createEnu(config)
}

module.exports = Enu

Object.assign(
  Enu,
  {
    version: '16.0.0',
    modules: {
      format,
      api: EnuApi,
      ecc,
      json: {
        api: EnuApi.api,
        schema
      },
      Fcbuffer
    },

    /** @deprecated */
    Testnet: function (config) {
      console.error('deprecated, change Enu.Testnet(..) to just Enu(..)')
      return Enu(config)
    },

    /** @deprecated */
    Localnet: function (config) {
      console.error('deprecated, change Enu.Localnet(..) to just Enu(..)')
      return Enu(config)
    }
  }
)

function createEnu(config) {
  const network = config.httpEndpoint != null ? EnuApi(config) : null
  config.network = network

  const abis = []
  const abiCache = AbiCache(network, config)
  abis.push(abiCache.abi('enumivo.null', enumivo_null))
  abis.push(abiCache.abi('enu.token', token))
  abis.push(abiCache.abi('enumivo', system))

  if(!config.chainId) {
    config.chainId = 'cf057bbfb72640471fd910bcb67639c22df9f92470936cddc1ade0e2f2e7dc4f'
  }

  if(network) {
    checkChainId(network, config.chainId, config.logger)
  }

  if(config.mockTransactions != null) {
    if(typeof config.mockTransactions === 'string') {
      const mock = config.mockTransactions
      config.mockTransactions = () => mock
    }
    assert.equal(typeof config.mockTransactions, 'function', 'config.mockTransactions')
  }
  const {structs, types, fromBuffer, toBuffer} = Structs(config)
  const enu = mergeWriteFunctions(config, EnuApi, structs, abis)

  Object.assign(enu, {
    config: safeConfig(config),
    fc: {
      structs,
      types,
      fromBuffer,
      toBuffer,
      abiCache
    },
    // Repeat of static Enu.modules, help apps that use dependency injection
    modules: {
      format
    }
  })

  if(!config.signProvider) {
    config.signProvider = defaultSignProvider(enu, config)
  }

  return enu
}

/**
  Set each property as read-only, read-write, no-access.  This is shallow
  in that it applies only to the root object and does not limit access
  to properties under a given object.
*/
function safeConfig(config) {
  // access control is shallow references only
  const readOnly = new Set(['httpEndpoint', 'abiCache', 'chainId', 'expireInSeconds'])
  const readWrite = new Set(['verbose', 'debug', 'broadcast', 'logger', 'sign'])
  const protectedConfig = {}

  Object.keys(config).forEach(key => {
    Object.defineProperty(protectedConfig, key, {
      set: function(value) {
        if(readWrite.has(key)) {
          config[key] = value
          return
        }
        throw new Error('Access denied')
      },

      get: function() {
        if(readOnly.has(key) || readWrite.has(key)) {
          return config[key]
        }
        throw new Error('Access denied')
      }
    })
  })
  return protectedConfig
}

/**
  Merge in write functions (operations).  Tested against existing methods for
  name conflicts.

  @arg {object} config.network - read-only api calls
  @arg {object} EnuApi - api[EnuApi] read-only api calls
  @return {object} - read and write method calls (create and sign transactions)
  @throw {TypeError} if a funciton name conflicts
*/
function mergeWriteFunctions(config, EnuApi, structs, abis) {
  const {network} = config

  const merge = Object.assign({}, network)

  const writeApi = writeApiGen(EnuApi, network, structs, config, abis)
  throwOnDuplicate(merge, writeApi, 'Conflicting methods in EnuApi and Transaction Api')
  Object.assign(merge, writeApi)

  return merge
}

function throwOnDuplicate(o1, o2, msg) {
  for(const key in o1) {
    if(o2[key]) {
      throw new TypeError(msg + ': ' + key)
    }
  }
}

/**
  The default sign provider is designed to interact with the available public
  keys (maybe just one), the transaction, and the blockchain to figure out
  the minimum set of signing keys.

  If only one key is available, the blockchain API calls are skipped and that
  key is used to sign the transaction.
*/
const defaultSignProvider = (enu, config) => async function({
  sign, buf, transaction, optionsKeyProvider
}) {
  // optionsKeyProvider is a per-action key: await enu.someAction('user2' .., {keyProvider: privateKey2})
  const keyProvider = optionsKeyProvider ? optionsKeyProvider : config.keyProvider

  if(!keyProvider) {
    throw new TypeError('This transaction requires a keyProvider for signing')
  }

  let keys = keyProvider
  if(typeof keyProvider === 'function') {
    keys = keyProvider({transaction})
  }

  // keyProvider may return keys or Promise<keys>
  keys = await Promise.resolve(keys)

  if(!Array.isArray(keys)) {
    keys = [keys]
  }

  keys = keys.map(key => {
    try {
      // normalize format (WIF => PVT_K1_base58privateKey)
      return {private: ecc.PrivateKey(key).toString()}
    } catch(e) {
      // normalize format (ENUKey => PUB_K1_base58publicKey)
      return {public: ecc.PublicKey(key).toString()}
    }
    assert(false, 'expecting public or private keys from keyProvider')
  })

  if(!keys.length) {
    throw new Error('missing key, check your keyProvider')
  }

  // simplify default signing #17
  if(keys.length === 1 && keys[0].private) {
    const pvt = keys[0].private
    return sign(buf, pvt)
  }

  // offline signing assumes all keys provided need to sign
  if(config.httpEndpoint == null) {
    const sigs = []
    for(const key of keys) {
      sigs.push(sign(buf, key.private))
    }
    return sigs
  }

  const keyMap = new Map()

  // keys are either public or private keys
  for(const key of keys) {
    const isPrivate = key.private != null
    const isPublic = key.public != null

    if(isPrivate) {
      keyMap.set(ecc.privateToPublic(key.private), key.private)
    } else {
      keyMap.set(key.public, null)
    }
  }

  const pubkeys = Array.from(keyMap.keys())

  return enu.getRequiredKeys(transaction, pubkeys).then(({required_keys}) => {
    if(!required_keys.length) {
      throw new Error('missing required keys for ' + JSON.stringify(transaction))
    }

    const pvts = [], missingKeys = []

    for(let requiredKey of required_keys) {
      // normalize (ENUKey.. => PUB_K1_Key..)
      requiredKey = ecc.PublicKey(requiredKey).toString()

      const wif = keyMap.get(requiredKey)
      if(wif) {
        pvts.push(wif)
      } else {
        missingKeys.push(requiredKey)
      }
    }

    if(missingKeys.length !== 0) {
      assert(typeof keyProvider === 'function',
        'keyProvider function is needed for private key lookup')

      // const pubkeys = missingKeys.map(key => ecc.PublicKey(key).toStringLegacy())
      keyProvider({pubkeys: missingKeys})
        .forEach(pvt => { pvts.push(pvt) })
    }

    const sigs = []
    for(const pvt of pvts) {
      sigs.push(sign(buf, pvt))
    }

    return sigs
  })
}

function checkChainId(network, chainId, logger) {
  network.getInfo({}).then(info => {
    if(info.chain_id !== chainId) {
      if(logger.log) {
        logger.log(
          'chainId mismatch, signatures will not match transaction authority. ' +
          `expected ${chainId} !== actual ${info.chain_id}`
        )
      }
    }
  }).catch(error => {
    if(logger.error) {
      logger.error('Warning, unable to validate chainId: ' + error.message)
    }
  })
}
