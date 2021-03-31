const ejs = require('ejs')
const GeneratorAPI = require('./GeneratorAPI')
const PackageManager = require('./util/ProjectPackageManager')
const sortObject = require('./util/sortObject')
const writeFileTree = require('./util/writeFileTree')
const inferRootOptions = require('./util/inferRootOptions')
const normalizeFilePaths = require('./util/normalizeFilePaths')
const runCodemod = require('./util/runCodemod')
const {
  semver,
  isPlugin,
  toShortPluginId,
  matchesPluginId,
  loadModule
} = require('@pkb/shared-utils')

const ConfigTransform = require('./ConfigTransform')
const logger = require('@pkb/shared-utils/lib/logger')
const logTypes = {
  log: logger.log,
  info: logger.info,
  done: logger.done,
  warn: logger.warn,
  error: logger.error
}

const reservedConfigTransforms = {
  vue: new ConfigTransform({
    file: {
      js: ['vue.config.js']
    }
  })
}

const ensureEOL = str => {
  if (str.charAt(str.length - 1) !== '\n') {
    return str + '\n'
  }
  return str
}

module.exports = class Generator {
  constructor (context, {
    pkg = {},
    plugins = [],
    afterInvokeCbs = [],
    afterAnyInvokeCbs = [],
    files = {},
    invoking = false
  } = {}) {
    this.context = context
    this.plugins = plugins
    this.originalPkg = pkg
    this.pkg = Object.assign({}, pkg)
    this.pm = new PackageManager({ context })
    this.imports = {}
    this.rootOptions = {}
    this.passedAfterInvokeCbs = afterInvokeCbs
    this.afterInvokeCbs = []
    this.afterAnyInvokeCbs = afterAnyInvokeCbs
    this.configTransforms = {}
    this.reservedConfigTransforms = reservedConfigTransforms
    this.invoking = invoking
    this.depSources = {}
    this.files = files
    this.fileMiddlewares = []
    this.postProcessFilesCbs = []
    this.exitLogs = []

    this.allPluginIds = Object.keys(this.pkg.dependencies || {})
      .concat(Object.keys(this.pkg.devDependencies || {}))
      .filter(isPlugin)

    const cliService = plugins.find(p => p.id === '@vue/cli-service')
    const rootOptions = cliService
      ? cliService.options
      : inferRootOptions(pkg)

    this.rootOptions = rootOptions
  }

  async initPlugins () {
    const { rootOptions, invoking } = this
    const pluginIds = this.plugins.map(p => p.id)
    for (const id of this.allPluginIds) {
      const api = new GeneratorAPI(id, this, {}, rootOptions)
      const pluginGenerator = loadModule(`${id}/generator`, this.context)

      if (pluginGenerator && pluginGenerator.hooks) {
        await pluginGenerator.hooks(api, {}, rootOptions, pluginIds)
      }
    }

    const afterAnyInvokeCbsFromPlugins = this.afterAnyInvokeCbs

    // reset hooks
    this.afterInvokeCbs = this.passedAfterInvokeCbs
    this.afterAnyInvokeCbs = []
    this.postProcessFilesCbs = []

    // apply generators from plugins
    for (const plugin of this.plugins) {
      const { id, apply, options } = plugin
      const api = new GeneratorAPI(id, this, options, rootOptions)
      await apply(api, options, rootOptions, invoking)

      if (apply.hooks) {
        // while we execute the entire `hooks` function,
        // only the `afterInvoke` hook is respected
        // because `afterAnyHooks` is already determined by the `allPluginIds` loop above
        await apply.hooks(api, options, rootOptions, pluginIds)
      }

      // restore "any" hooks
      this.afterAnyInvokeCbs = afterAnyInvokeCbsFromPlugins
    }
  }

  async generate ({
    checkExisting = false
  } = {}) {
    await this.initPlugins()

    // save the file system before applying plugin for comparison
    const initialFiles = Object.assign({}, this.files)
    // wait for file resolve
    await this.resolveFiles()
    // set package.json
    this.sortPkg()
    this.files['package.json'] = JSON.stringify(this.pkg, null, 2) + '\n'
    // write/update file tree to disk
    await writeFileTree(this.context, this.files, initialFiles)
  }

  sortPkg () {
    // ensure package.json keys has readable order
    this.pkg.dependencies = sortObject(this.pkg.dependencies)
    this.pkg.devDependencies = sortObject(this.pkg.devDependencies)
    this.pkg.scripts = sortObject(this.pkg.scripts, [
      'serve',
      'build',
      'test:unit',
      'test:e2e',
      'lint',
      'deploy'
    ])
    this.pkg = sortObject(this.pkg, [
      'name',
      'version',
      'private',
      'description',
      'author',
      'scripts',
      'main',
      'bin',
      'module',
      'browser',
      'jsDelivr',
      'unpkg',
      'files',
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'babel',
      'eslintConfig',
      'prettier',
      'postcss',
      'browserslist'
    ])
  }

  async resolveFiles () {
    const files = this.files
    for (const middleware of this.fileMiddlewares) {
      await middleware(files, ejs.render)
    }

    // normalize file paths on windows
    // all paths are converted to use / instead of \
    normalizeFilePaths(files)

    // handle imports and root option injections
    Object.keys(files).forEach(file => {
      let imports = this.imports[file]
      imports = imports instanceof Set ? Array.from(imports) : imports
      if (imports && imports.length > 0) {
        files[file] = runCodemod(
          require('./util/codemods/injectImports'),
          { path: file, source: files[file] },
          { imports }
        )
      }

      let injections = this.rootOptions[file]
      injections = injections instanceof Set ? Array.from(injections) : injections
      if (injections && injections.length > 0) {
        files[file] = runCodemod(
          require('./util/codemods/injectOptions'),
          { path: file, source: files[file] },
          { injections }
        )
      }
    })

    for (const postProcess of this.postProcessFilesCbs) {
      await postProcess(files)
    }
  }

  hasPlugin (_id, _version) {
    return [
      ...this.plugins.map(p => p.id),
      ...this.allPluginIds
    ].some(id => {
      if (!matchesPluginId(_id, id)) {
        return false
      }

      if (!_version) {
        return true
      }

      const version = this.pm.getInstalledVersion(id)
      return semver.satisfies(version, _version)
    })
  }

  printExitLogs () {
    if (this.exitLogs.length) {
      this.exitLogs.forEach(({ id, msg, type }) => {
        const shortId = toShortPluginId(id)
        const logFn = logTypes[type]
        if (!logFn) {
          logger.error(`Invalid api.exitLog type '${type}'.`, shortId)
        } else {
          logFn(msg, msg && shortId)
        }
      })
      logger.log()
    }
  }
}
