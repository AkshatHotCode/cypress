/* eslint-disable no-dupe-class-members */
import path from 'path'
import { fork } from 'child_process'
import type { ForkOptions } from 'child_process'
import assert from 'assert'
import _ from 'lodash'
import type { DataContext } from '..'
import {
  cleanUpIntegrationFolder,
  formatConfig,
  LegacyCypressConfigJson,
  moveSpecFiles,
  NonStandardMigrationError,
  SpecToMove,
} from '../sources'
import {
  tryGetDefaultLegacyPluginsFile,
  supportFilesForMigration,
  hasSpecFile,
  getStepsForMigration,
  getIntegrationFolder,
  isDefaultTestFiles,
  getComponentTestFilesGlobs,
  getComponentFolder,
  getIntegrationTestFilesGlobs,
  getSpecPattern,
  legacyOptions,
} from '../sources/migration'
import { makeCoreData } from '../data'
import { LegacyPluginsIpc } from '../data/LegacyPluginsIpc'

export function getConfigWithDefaults (legacyConfig: any) {
  const newConfig = _.cloneDeep(legacyConfig)

  legacyOptions.forEach(({ defaultValue, name }) => {
    if (defaultValue !== undefined && legacyConfig[name] === undefined) {
      newConfig[name] = typeof defaultValue === 'function' ? defaultValue() : defaultValue
    }
  })

  return newConfig
}

export function getDiff (oldConfig: any, newConfig: any) {
  // get all the values updated
  const result: any = _.reduce(oldConfig, (acc: any, value, key) => {
    // ignore values that have been removed
    if (newConfig[key] && !_.isEqual(value, newConfig[key])) {
      acc[key] = newConfig[key]
    }

    return acc
  }, {})

  // get all the values added
  return _.reduce(newConfig, (acc: any, value, key) => {
    // their key is in the new config but not in the old config
    if (!oldConfig.hasOwnProperty(key)) {
      acc[key] = value
    }

    return acc
  }, result)
}

export async function processConfigViaLegacyPlugins (projectRoot: string, legacyConfig: LegacyCypressConfigJson): Promise<LegacyCypressConfigJson> {
  const pluginFile = legacyConfig.pluginsFile ?? await tryGetDefaultLegacyPluginsFile(projectRoot)

  return new Promise((resolve, reject) => {
    // couldn't find a pluginsFile
    // just bail with initial config
    if (!pluginFile) {
      return resolve(legacyConfig)
    }

    const cwd = path.join(projectRoot, pluginFile)

    const { CYPRESS_INTERNAL_E2E_TESTING_SELF, ...env } = process.env

    const childOptions: ForkOptions = {
      stdio: 'inherit',
      cwd: path.dirname(cwd),
      env,
    }

    const configProcessArgs = ['--projectRoot', projectRoot, '--file', cwd]
    const CHILD_PROCESS_FILE_PATH = require.resolve('@packages/server/lib/plugins/child/require_async_child')
    const ipc = new LegacyPluginsIpc(fork(CHILD_PROCESS_FILE_PATH, configProcessArgs, childOptions))

    const legacyConfigWithDefaults = getConfigWithDefaults(legacyConfig)

    ipc.on('ready', () => {
      ipc.send('loadLegacyPlugins', legacyConfigWithDefaults)
    })

    ipc.on('loadLegacyPlugins:reply', (modifiedLegacyConfig) => {
      const diff = getDiff(legacyConfigWithDefaults, modifiedLegacyConfig)

      // if env is updated by plugins, avoid adding it to the config file
      if (diff.env) {
        delete diff.env
      }

      const legacyConfigWithChanges = _.merge(legacyConfig, diff)

      resolve(legacyConfigWithChanges)
      ipc.childProcess.kill()
    })

    ipc.on('loadLegacyPlugins:error', (error) => {
      reject(error)
      ipc.childProcess.kill()
    })

    ipc.on('childProcess:unhandledError', (error) => {
      reject(error)
      ipc.childProcess.kill()
    })
  })
}

export class MigrationActions {
  constructor (private ctx: DataContext) { }

  async initialize (config: LegacyCypressConfigJson) {
    const legacyConfigForMigration = await this.setLegacyConfigForMigration(config)

    // for testing mainly, we want to ensure the flags are reset each test
    this.resetFlags()

    if (!this.ctx.currentProject || !legacyConfigForMigration) {
      throw Error('cannot do migration without currentProject!')
    }

    await this.initializeFlags()

    const legacyConfigFileExist = this.ctx.migration.legacyConfigFileExists()
    const filteredSteps = await getStepsForMigration(this.ctx.currentProject, legacyConfigForMigration, Boolean(legacyConfigFileExist))

    this.ctx.update((coreData) => {
      if (!filteredSteps[0]) {
        throw Error(`Impossible to initialize a migration. No steps fit the configuration of this project.`)
      }

      coreData.migration.filteredSteps = filteredSteps
      coreData.migration.step = filteredSteps[0]
    })
  }

  /**
   * Figure out all the data required for the migration UI.
   * This drives which migration steps need be shown and performed.
   */
  private async initializeFlags () {
    const legacyConfigForMigration = this.ctx.coreData.migration.legacyConfigForMigration

    if (!this.ctx.currentProject || !legacyConfigForMigration) {
      throw Error('Need currentProject to do migration')
    }

    const integrationFolder = getIntegrationFolder(legacyConfigForMigration)
    const integrationTestFiles = getIntegrationTestFilesGlobs(legacyConfigForMigration)

    const hasCustomIntegrationFolder = getIntegrationFolder(legacyConfigForMigration) !== 'cypress/integration'
    const hasCustomIntegrationTestFiles = !isDefaultTestFiles(legacyConfigForMigration, 'integration')

    let hasE2ESpec = integrationFolder
      ? await hasSpecFile(this.ctx.currentProject, integrationFolder, integrationTestFiles)
      : false

    // if we don't find specs in the 9.X scope,
    // let's check already migrated files.
    // this allows users to stop migration halfway,
    // then to pick up where they left migration off
    if (!hasE2ESpec && (!hasCustomIntegrationTestFiles || !hasCustomIntegrationFolder)) {
      const newE2eSpecPattern = getSpecPattern(legacyConfigForMigration, 'e2e')

      hasE2ESpec = await hasSpecFile(this.ctx.currentProject, '', newE2eSpecPattern)
    }

    const componentFolder = getComponentFolder(legacyConfigForMigration)
    const componentTestFiles = getComponentTestFilesGlobs(legacyConfigForMigration)

    const hasCustomComponentFolder = componentFolder !== 'cypress/component'
    const hasCustomComponentTestFiles = !isDefaultTestFiles(legacyConfigForMigration, 'component')

    // A user is considered to "have" component testing if either
    // 1. they have a default component folder (cypress/component) with at least 1 spec file
    // OR
    // 2. they have configured a non-default componentFolder (even if it doesn't have any specs.)
    const hasSpecInDefaultComponentFolder = await hasSpecFile(this.ctx.currentProject, componentFolder, componentTestFiles)
    const hasComponentTesting = (hasCustomComponentFolder || hasSpecInDefaultComponentFolder) ?? false

    this.ctx.update((coreData) => {
      coreData.migration.flags = {
        hasCustomIntegrationFolder,
        hasCustomIntegrationTestFiles,
        hasCustomComponentFolder,
        hasCustomComponentTestFiles,
        hasCustomSupportFile: false,
        hasComponentTesting,
        hasE2ESpec,
        hasPluginsFile: true,
      }
    })
  }

  get configFileNameAfterMigration () {
    return this.ctx.migration.legacyConfigFile.replace('.json', `.config.${this.ctx.lifecycleManager.fileExtensionToUse}`)
  }

  async createConfigFile () {
    const config = await this.ctx.migration.createConfigString()

    this.ctx.lifecycleManager.setConfigFilePath(this.configFileNameAfterMigration)

    await this.ctx.fs.writeFile(this.ctx.lifecycleManager.configFilePath, config).catch((error) => {
      throw error
    })

    await this.ctx.actions.file.removeFileInProject(this.ctx.migration.legacyConfigFile).catch((error) => {
      throw error
    })

    // @ts-ignore configFile needs to be updated with the new one, so it finds the correct one
    // with the new file, instead of the deleted one which is not supported anymore
    this.ctx.modeOptions.configFile = this.ctx.migration.configFileNameAfterMigration
  }

  async setLegacyConfigForMigration (config: LegacyCypressConfigJson) {
    assert(this.ctx.currentProject)
    const legacyConfigForMigration = await processConfigViaLegacyPlugins(this.ctx.currentProject, config)

    this.ctx.update((coreData) => {
      coreData.migration.legacyConfigForMigration = legacyConfigForMigration
    })

    return legacyConfigForMigration
  }

  async renameSpecsFolder () {
    if (!this.ctx.currentProject) {
      throw Error('Need to set currentProject before you can rename specs folder')
    }

    const projectRoot = this.ctx.path.join(this.ctx.currentProject)
    const from = path.join(projectRoot, 'cypress', 'integration')
    const to = path.join(projectRoot, 'cypress', 'e2e')

    await this.ctx.fs.move(from, to)
  }

  async renameSpecFiles (beforeSpecs: string[], afterSpecs: string[]) {
    if (!this.ctx.currentProject) {
      throw Error('Need to set currentProject before you can rename files')
    }

    const specsToMove: SpecToMove[] = []

    for (let i = 0; i < beforeSpecs.length; i++) {
      const from = beforeSpecs[i]
      const to = afterSpecs[i]

      if (!from || !to) {
        throw Error(`Must have matching to and from. Got from: ${from} and to: ${to}`)
      }

      specsToMove.push({ from, to })
    }

    const projectRoot = this.ctx.path.join(this.ctx.currentProject)

    await moveSpecFiles(projectRoot, specsToMove)
    await cleanUpIntegrationFolder(this.ctx.currentProject)
  }

  async renameSupportFile () {
    if (!this.ctx.currentProject) {
      throw Error(`Need current project before starting migration!`)
    }

    const result = await supportFilesForMigration(this.ctx.currentProject)

    const beforeRelative = result.before.relative
    const afterRelative = result.after.relative

    if (!beforeRelative || !afterRelative) {
      throw new NonStandardMigrationError('support')
    }

    this.ctx.fs.renameSync(
      path.join(this.ctx.currentProject, beforeRelative),
      path.join(this.ctx.currentProject, afterRelative),
    )
  }

  async finishReconfigurationWizard () {
    this.ctx.lifecycleManager.refreshMetaState()
    await this.ctx.lifecycleManager.refreshLifecycle()
  }

  async nextStep () {
    const filteredSteps = this.ctx.coreData.migration.filteredSteps
    const index = filteredSteps.indexOf(this.ctx.coreData.migration.step)

    if (index === -1) {
      throw new Error('Invalid step')
    }

    const nextIndex = index + 1

    if (nextIndex < filteredSteps.length) {
      const nextStep = filteredSteps[nextIndex]

      if (nextStep) {
        this.ctx.update((coreData) => {
          coreData.migration.step = nextStep
        })
      }
    } else {
      await this.finishReconfigurationWizard()
    }
  }

  async closeManualRenameWatcher () {
    await this.ctx.migration.closeManualRenameWatcher()
  }

  async assertSuccessfulConfigMigration (migratedConfigFile: string = 'cypress.config.js') {
    const actual = formatConfig(await this.ctx.file.readFileInProject(migratedConfigFile))

    const configExtension = path.extname(migratedConfigFile)
    const expected = formatConfig(await this.ctx.file.readFileInProject(`expected-cypress.config${configExtension}`))

    if (actual !== expected) {
      throw Error(`Expected ${actual} to equal ${expected}`)
    }
  }

  resetFlags () {
    this.ctx.update((coreData) => {
      const defaultFlags = makeCoreData().migration.flags

      coreData.migration.flags = defaultFlags
    })
  }
}