import * as args from 'args'
import * as path from 'path'
import {ELogLevel} from './log'

/**
 * CLI argument names
 */
export enum ECliArgument {
  /**
   * Main file of non-bundled package source
   */
  entry = 'entry',

  /**
   * Root directory of targeted package
   */
  root = 'root',

  /**
   * Temporary directory required during generation
   */
  tmp = 'tmp',

  /**
   * Additional TSC properties
   */
  tsc = 'tsc',

  /**
   * Selected logging level
   */
  logLevel = 'logLevel',

  /**
   * Output file path (relative to root)
   */
  output = 'output',

  /**
   * Flag which forces using own TSC as opposed to target TSC
   * This should only be used for testing npm-dts itself
   * This is because it generates incorrect module names
   */
  testMode = 'testMode',
}

/**
 * Format for storing passed argument values
 */
export interface INpmDtsArgs {
  /**
   * Iterator
   */
  [argName: string]: string | boolean

  /**
   * Main file of non-bundled package source
   */
  entry?: string

  /**
   * Root directory of targeted package
   */
  root?: string

  /**
   * Temporary directory required during generation
   */
  tmp?: string

  /**
   * Additional TSC properties
   */
  tsc?: string

  /**
   * Selected logging level
   */
  logLevel?: ELogLevel

  /**
   * Output file path (relative to root)
   */
  output?: string

  /**
   * Flag which forces using own TSC as opposed to target TSC
   * This should only be used for testing npm-dts itself
   * This is because it generates incorrect module names
   */
  testMode?: boolean
}

/**
 * CLI usage logic
 */
export class Cli {
  /**
   * Stores whether module was successfully launched
   */
  protected launched = false

  /**
   * Stores whether TMP directory location was passed
   */
  protected tmpPassed = false

  /**
   * Stores current CLI argument values
   */
  private args: INpmDtsArgs = {
    entry: 'index.ts',
    root: path.resolve(process.cwd()),
    tmp: path.resolve(process.cwd(), '.atomic'),
    tsc: '',
    logLevel: ELogLevel.info,
    output: 'index.d.ts',
    testMode: false,
  }

  /**
   * Automatically reads CLI arguments and performs actions based on them
   */
  public constructor(injectedArguments?: INpmDtsArgs) {
    if (injectedArguments) {
      this.launched = true
      this.storeArguments(injectedArguments)
    } else {
      args
        .option(
          ['e', 'entry'],
          'Entry/main package file before bundling, relative to project root',
        )
        .option(
          ['r', 'root'],
          'NPM package directory containing package.json',
          this.args.root,
        )
        .option(
          ['t', 'tmp'],
          'Directory for storing temporary information',
          this.args.tmp,
          (value: string) => {
            if (!value.includes('<')) {
              this.tmpPassed = true
            }

            return value
          },
        )
        .option(
          ['c', 'tsc'],
          'Passed through non-validated additional TSC options',
          this.args.tsc,
        )
        .option(
          ['L', 'logLevel'],
          'Log level (error, warn, info, verbose, debug)',
          this.args.logLevel,
        )
        .option(
          ['o', 'output'],
          'Overrides recommended output target to a custom one',
          this.args.output,
        )
        .option(
          ['m', 'testMode'],
          'Configures ato-mat-ic for self-test',
          this.args.testMode,
        )
        .command('generate', 'Start generation', (name, sub, options) => {
          this.launched = true
          this.storeArguments(options)
        })
        .example(
          'ato-mat-ic generate',
          'Generates index.d.ts file and updates package.json for CWD.',
        )
        .example(
          'ato-mat-ic -r /your/project/path generate',
          'Performs generation on a custom path.',
        )

      args.parse(process.argv, {
        name: 'ato-mat-ic',
        mri: {},
        mainColor: 'yellow',
        subColor: 'dim',
      })

      if (!this.launched) {
        args.showHelp()
      }
    }
  }

  /**
   * Gathers current value of a particular CLI argument
   * @param arg argument name
   */
  protected getArgument(arg: ECliArgument) {
    return this.args[arg]
  }

  /**
   * Dynamically overrides value of stored argument
   * @param arg argument name
   * @param value argument value
   */
  protected setArgument(arg: ECliArgument, value: string | boolean) {
    // @ts-ignore
    this.args[arg] = value
  }

  /**
   * Stores entered CLI arguments
   * @param passedArguments arguments entered to CLI
   */
  private storeArguments(passedArguments: any = this.args) {
    for (const argName of Object.keys(this.args)) {
      this.args[argName] = Object.is(passedArguments[argName], undefined)
        ? this.args[argName]
        : passedArguments[argName]
    }
  }
}
