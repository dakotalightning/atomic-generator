import {readdirSync, statSync, writeFileSync} from 'fs'
import {readFileSync} from 'fs'
import * as mkdir from 'mkdirp'
import * as npmRun from 'npm-run'
import {join, relative, resolve, dirname} from 'path'
import * as rm from 'rimraf'
import * as tmp from 'tmp'
import {Cli, ECliArgument, INpmDtsArgs} from './cli'
import {debug, ELogLevel, error, info, init, verbose, warn} from './log'
import * as fs from 'fs'

const MKDIR_RETRIES = 5

/**
 * Logic for generating aggregated typings for NPM module
 */
 export class Generator extends Cli {
  private packageInfo: any
  private moduleNames: string[]
  private throwErrors: boolean
  private cacheContentEmptied: boolean = true

  /**
   * Auto-launches generation based on command line arguments
   * @param injectedArguments generation arguments (same as CLI)
   * @param enableLog enables logging when true, null allows application to decide
   * @param throwErrors makes generation throw errors when true
   */
  public constructor(
    injectedArguments?: INpmDtsArgs,
    enableLog: boolean | null = null,
    throwErrors = false,
  ) {
    super(injectedArguments)

    this.throwErrors = throwErrors

    if (enableLog === null) {
      enableLog = !injectedArguments
    }

    if (enableLog) {
      const myPackageJson = JSON.parse(
        readFileSync(resolve(__dirname, '..', 'package.json'), {
          encoding: 'utf8',
        }),
      )

      init(myPackageJson.name, this.getLogLevel())
      info(`${myPackageJson.name} v${myPackageJson.version}`)
    }
  }

  /**
   * Executes generation of single declaration file
   */
  public async generate() {
    info(`Generating declarations for "${this.getRoot()}"...`)

    let hasError = false
    let exception = null
    const cleanupTasks: (() => void)[] = []

    if (!this.tmpPassed) {
      verbose('Locating OS Temporary Directory...')

      try {
        await new Promise<void>(done => {
          tmp.dir((tmpErr, tmpDir, rmTmp) => {
            if (tmpErr) {
              error('Could not create OS Temporary Directory!')
              this.showDebugError(tmpErr)
              throw tmpErr
            }

            verbose('OS Temporary Directory was located!')
            this.setArgument(ECliArgument.tmp, resolve(tmpDir, 'npm-dts'))

            cleanupTasks.push(() => {
              verbose('Deleting OS Temporary Directory...')
              rmTmp()
              verbose('OS Temporary Directory was deleted!')
            })
            done()
          })
        })
      } catch (e) {
        hasError = true
        exception = e
      }
    }

    if (!hasError) {
      await this._generate().catch(async e => {
        hasError = true

        const output = this.getOutput()

        error(`Generation of ${output} has failed!`)
        this.showDebugError(e)

        if (!this.cacheContentEmptied) {
          await this.clearTempDir()
        }

        exception = e
      })
    }

    cleanupTasks.forEach(task => task())

    if (!hasError) {
      info('Generation is completed!')
    } else {
      error('Generation failed!')

      if (this.throwErrors) {
        throw exception || new Error('Generation failed!')
      }
    }
  }

  /**
   * Launches generation of typings
   */
   private async _generate() {
    await this.generateTypings()
    const source = await this.combineTypings()
    await this.storeResult(source)
  }

  /**
   * Logs serialized error if it exists
   * @param e - error to be shown
   */
   private showDebugError(e: any) {
    if (e) {
      if (e.stdout) {
        debug(`Error: \n${e.stdout.toString()}`)
      } else {
        debug(`Error: \n${JSON.stringify(e)}`)
      }
    }
  }

  private getLogLevel(): ELogLevel {
    const logLevel = this.getArgument(ECliArgument.logLevel) as ELogLevel
    return ELogLevel[logLevel] ? logLevel : ELogLevel.info
  }

  /**
   * Gathers entry file address (relative to project root path)
   */
  private getEntry(): string {
    return this.getArgument(ECliArgument.entry) as string
  }

  /**
   * Gathers target project root path
   */
  private getRoot(): string {
    return resolve(this.getArgument(ECliArgument.root) as string)
  }

  /**
   * Gathers TMP directory to be used for TSC operations
   */
  private getTempDir(): string {
    return resolve(this.getArgument(ECliArgument.tmp) as string)
  }

  /**
   * Gathers output path to be used (relative to root)
   */
  private getOutput(): string {
    return this.getArgument(ECliArgument.output) as string
  }

  /**
   * Checks if script is forced to use its built-in TSC
   */
  private useTestMode(): boolean {
    return this.getArgument(ECliArgument.testMode) as boolean
  }

  /**
   * Creates TMP directory to be used for TSC operations
   * @param retries amount of times to retry on failure
   */
   private makeTempDir(retries = MKDIR_RETRIES): Promise<void> {
    const tmpDir = this.getTempDir()
    verbose('Preparing "tmp" directory...')

    return new Promise((done, fail) => {
      mkdir(tmpDir)
        .then(() => {
          this.cacheContentEmptied = false
          verbose('"tmp" directory was prepared!')
          done()
        })
        .catch(mkdirError => {
          error(`Failed to create "${tmpDir}"!`)
          this.showDebugError(mkdirError)

          if (retries) {
            const sleepTime = 100
            verbose(`Will retry in ${sleepTime}ms...`)

            setTimeout(() => {
              this.makeTempDir(retries - 1).then(done, fail)
            }, sleepTime)
          } else {
            error(`Stopped trying after ${MKDIR_RETRIES} retries!`)
            fail()
          }
        })
    })
  }

  /**
   * Removes TMP directory
   */
  private clearTempDir() {
    const tmpDir = this.getTempDir()
    verbose('Cleaning up "tmp" directory...')

    return new Promise<void>((done, fail) => {
      rm(tmpDir, rmError => {
        if (rmError) {
          error(`Could not clean up "tmp" directory at "${tmpDir}"!`)
          this.showDebugError(rmError)
          fail()
        } else {
          this.cacheContentEmptied = true
          verbose('"tmp" directory was cleaned!')
          done()
        }
      })
    })
  }

  /**
   * Re-creates empty TMP directory to be used for TSC operations
   */
   private resetCacheDir() {
    verbose('Will now reset "tmp" directory...')
    return new Promise((done, fail) => {
      this.clearTempDir().then(() => {
        this.makeTempDir().then(done, fail)
      }, fail)
    })
  }

  /**
   * Generates per-file typings using TSC
   */
  private async generateTypings() {
    await this.resetCacheDir()

    verbose('Generating per-file typings using TSC...')

    const tscOptions = this.getArgument(ECliArgument.tsc) as string

    const cmd =
      'tsc --declaration --emitDeclarationOnly --declarationDir "' +
      this.getTempDir() +
      '"' +
      (tscOptions.length ? ` ${tscOptions}` : '')

    debug(cmd)

    try {
      npmRun.execSync(
        cmd,
        {
          cwd: this.useTestMode() ? resolve(__dirname, '..') : this.getRoot(),
        },
        (err: any, stdout: any, stderr: any) => {
          if (err) {
            error('TSC exited with errors!')

            this.showDebugError(err)
          } else {
            if (stdout) {
              process.stdout.write(stdout)
            }

            if (stderr) {
              process.stderr.write(stderr)
            }
          }
        },
      )
    } catch (e) {
      throw e
    }

    verbose('Per-file typings have been generated using TSC!')
  }

  /**
   * Loads generated per-file declaration files
   */
   private loadTypings() {
    const result: IDeclarationMap = {}

    const declarationFiles = this.getDeclarationFiles()

    verbose('Loading declaration files and mapping to modules...')
    declarationFiles.forEach(file => {
      const moduleName = this.convertPathToModule(file)

      try {
        result[moduleName] = readFileSync(file, {encoding: 'utf8'})
      } catch (e) {
        error(`Could not load declaration file '${file}'!`)
        this.showDebugError(e)
        throw e
      }
    })

    verbose('Loaded declaration files and mapped to modules!')
    return result
  }

  /**
   * Combines typings into a single declaration source
   */
  private async combineTypings() {
    const typings = this.loadTypings()
    await this.clearTempDir()

    this.moduleNames = Object.keys(typings)

    verbose('Combining typings into single file...')

    const sourceParts: string[] = [
      '// Auto generated by ato-mat-ic\n'
    ]

    sourceParts.push('declare module "@components" {')

    Object.entries(typings).forEach(([moduleName, fileSource]) => {
      moduleName = moduleName.replace(/^([^/]+)\/index/, '$1')
      fileSource = fileSource.replace(/declare /g, '')
      fileSource = this.resolveImportSources(fileSource, moduleName)
      verbose(`Adding ${moduleName}`)
      sourceParts.push(
        `\n${(fileSource as string).replace(
          /^./gm,
          '  $&',
        ).replace(new RegExp(`export default ${moduleName}`, 'g'), `export { ${moduleName} }`)}`,
      )
    })
    sourceParts.push('}')

    verbose('Combined typings into a single file!')
    return sourceParts.join('\n')
  }

  private resolveImportSourcesAtLine(
    regexp: RegExp,
    line: string,
    moduleName: string,
  ) {
    const matches = line.match(regexp)

    if (matches && matches[2].startsWith('.')) {
      const relativePath = `../${matches[2]}`

      let resolvedModule = resolve(moduleName, relativePath)

      resolvedModule = this.convertPathToModule(resolvedModule, {
        rootType: IBasePathType.cwd,
        noPrefix: true,
        noExtensionRemoval: true,
      })

      if (!this.moduleExists(resolvedModule)) {
        resolvedModule += '/index'
      }

      line = line.replace(regexp, `$1${resolvedModule}$3`)
    }

    return line
  }

  /**
   * Verifies if module specified exists among known modules
   * @param moduleName name of module to be checked
   */
  private moduleExists(moduleName: string) {
    return this.moduleNames.includes(moduleName)
  }

  /**
   * Alters import sources to avoid relative addresses and default index usage
   * @param source import source to be resolved
   * @param moduleName name of module containing import
   */
  private resolveImportSources(source: string, moduleName: string) {
    source = source.replace(/\r\n/g, '\n')
    source = source.replace(/\n\r/g, '\n')
    source = source.replace(/\r/g, '\n')

    let lines = source.split('\n')

    lines = lines.map(line => {
      line = this.resolveImportSourcesAtLine(
        /(from ['"])([^'"]+)(['"])/,
        line,
        moduleName,
      )

      line = this.resolveImportSourcesAtLine(
        /(import\(['"])([^'"]+)(['"]\))/,
        line,
        moduleName,
      )

      return line
    })

    source = lines.join('\n')

    return source
  }

  /**
   * Gathers a list of created per-file declaration files
   * @param dir directory to be scanned for files (called during recursion)
   * @param files discovered array of files (called during recursion)
   */
   private getDeclarationFiles(
    dir: string = this.getTempDir(),
    files: string[] = [],
  ) {
    if (dir === this.getTempDir()) {
      verbose('Loading list of generated typing files...')
    }

    try {
      readdirSync(dir).forEach(file => {
        if (statSync(join(dir, file)).isDirectory()) {
          files = this.getDeclarationFiles(join(dir, file), files)
        } else {
          files = files.concat(join(dir, file))
        }
      })
    } catch (e) {
      error('Failed to load list of generated typing files...')
      this.showDebugError(e)
      throw e
    }

    if (dir === this.getTempDir()) {
      verbose('Successfully loaded list of generated typing files!')
    }

    return files
  }

  /**
   * Generates module name based on file path
   * @param path path to be converted to module name
   * @param options additional conversion options
   */
   private convertPathToModule(
    path: string,
    options: ConvertPathToModuleOptions = {},
  ) {
    const {
      rootType = IBasePathType.tmp,
      noExtensionRemoval = false,
      noExistenceCheck = false,
    } = options

    const fileExisted =
      noExistenceCheck ||
      (!noExtensionRemoval &&
        fs.existsSync(path) &&
        fs.lstatSync(path).isFile())

    if (rootType === IBasePathType.cwd) {
      path = relative(process.cwd(), path)
    } else if (rootType === IBasePathType.root) {
      path = relative(this.getRoot(), path)
    } else if (rootType === IBasePathType.tmp) {
      path = relative(this.getTempDir(), path)
    }

    path = path.replace(/\\/g, '/')

    if (fileExisted && !noExtensionRemoval) {
      path = path.replace(/\.[^.]+$/g, '')
      path = path.replace(/\.d$/g, '')
    }

    return path
  }

  /**
   * Stores generated .d.ts declaration source into file
   * @param source generated .d.ts source
   */
  private async storeResult(source: string) {
    const output = this.getOutput()
    const root = this.getRoot()
    const file = resolve(root, output)
    const folderPath = dirname(file)

    verbose('Ensuring that output folder exists...')
    debug(`Creating output folder: "${folderPath}"...`)

    try {
      await mkdir(folderPath)
    } catch (mkdirError) {
      error(`Failed to create "${folderPath}"!`)
      this.showDebugError(mkdirError)
      throw mkdirError
    }

    verbose('Output folder is ready!')
    verbose(`Storing typings into ${output} file...`)

    try {
      writeFileSync(file, source, {encoding: 'utf8'})
    } catch (e) {
      error(`Failed to create ${output}!`)
      this.showDebugError(e)
      throw e
    }

    verbose(`Successfully created ${output} file!`)
  }
}

/**
 * Map of modules and their declarations
 */
 export interface IDeclarationMap {
  [moduleNames: string]: string
}

/**
 * Types of base path used during path resolving
 */
export enum IBasePathType {
  /**
   * Base path is root of targeted project
   */
  root = 'root',

  /**
   * Base path is tmp directory
   */
  tmp = 'tmp',

  /**
   * Base path is CWD
   */
  cwd = 'cwd',
}

/**
 * Additional conversion options
 */
export interface ConvertPathToModuleOptions {
  /**
   * Type of base path used during path resolving
   */
  rootType?: IBasePathType

  /**
   * Disables addition of module name as prefix for module name
   */
  noPrefix?: boolean

  /**
   * Disables extension removal
   */
  noExtensionRemoval?: boolean

  /**
   * Disables existence check and assumes that file exists
   */
  noExistenceCheck?: boolean
}
