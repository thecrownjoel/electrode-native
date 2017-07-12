// @flow

import {
  generateContainer,
  generateMiniAppsComposite,
  GithubGenerator,
  MavenGenerator
} from '@walmart/ern-container-gen'
import {
  CodePushCommands,
  Dependency,
  findNativeDependencies,
  NativeApplicationDescriptor,
  Platform,
  yarn
} from '@walmart/ern-util'
import cauldron from './cauldron'
import inquirer from 'inquirer'
import _ from 'lodash'
import tmp from 'tmp'

function createContainerGenerator (platform, config) {
  if (config) {
    switch (config.name) {
      case 'maven':
        return new MavenGenerator({ mavenRepositoryUrl: config.mavenRepositoryUrl })
      case 'github':
        return new GithubGenerator({ targetRepoUrl: config.targetRepoUrl })
    }
  }

  // No generator configuration was provided
  // Create default generator for target native platform
  switch (platform) {
    case 'android':
      return new MavenGenerator()
    case 'ios':
      return new GithubGenerator()
  }
}

// Run container generator locally, without relying on the Cauldron, given a list of miniapp packages
// The string used to represent a miniapp package can be anything supported by `yarn add` command
// For example, the following miniapp strings are all valid
// FROM NPM => @walmart/react-native-cart@1.2.3
// FROM GIT => git@gecgithub01.walmart.com:react-native/Cart.git
// FROM FS  => file:/Users/blemair/Code/Cart
export async function runLocalContainerGen (
miniappPackages: Array<any>,
platform: 'android' | 'ios', {
  containerVersion = '1.0.0',
  nativeAppName = 'local',
  publicationUrl
}: {
  containerVersion?: string,
  nativeAppName?: string,
  publicationUrl?: string
} = {}) {
  try {
    const nativeDependencies: Set < string > = new Set()
    let miniapps = []
    let config

    if (publicationUrl) {
      config = platform === 'android' ? { name: 'maven', mavenRepositoryUrl: publicationUrl } : { name: 'github', targetRepoUrl: publicationUrl }
    }

    for (const miniappPackage of miniappPackages) {
      log.info(`Processing ${miniappPackage.toString()}`)

      // Create temporary directory and yarn add the miniapp from within it
      const tmpDirPath = tmp.dirSync({ unsafeCleanup: true }).name
      process.chdir(tmpDirPath)
      await yarn.yarnAdd(miniappPackage)

      // Extract full name of miniapp package from the package.json resulting from yarn add command
      const packageJson = require(`${tmpDirPath}/package.json`)
      const miniappDependency = Dependency.fromString(_.keys(packageJson.dependencies)[0])

      miniapps.push({
        scope: miniappDependency.scope,
        name: miniappDependency.name,
        packagePath: miniappPackage
      })

      // Find all native dependencies of this miniapp in the node_modules folder
      // and remove the miniapp itself, wrongly considered as a native dependency
      let miniappNativeDependencies = findNativeDependencies(`${tmpDirPath}/node_modules`)
      _.remove(miniappNativeDependencies,
      d => (d.scope === miniappDependency.scope) && (d.name === miniappDependency.name))

      // Add all native dependencies as strings to the set of native dependencies
      // of all miniapps
      miniappNativeDependencies.forEach(d => nativeDependencies.add(d.toString()))
    }

    const nativeDependenciesArray = Array.from(nativeDependencies)

    // Verify uniqueness of native dependencies (that all miniapps are using the same
    // native dependencies version). This is a requirement in order to generate a proper container
    const nativeDependenciesWithoutVersion: Array < string > = _.map(
    nativeDependenciesArray, d => Dependency.fromString(d).withoutVersion().toString())
    const duplicateNativeDependencies =
    _(nativeDependenciesWithoutVersion).groupBy().pickBy(x => x.length > 1).keys().value()
    if (duplicateNativeDependencies.length > 0) {
      throw new Error(`The following native dependencies are not using the same version: ${duplicateNativeDependencies}`)
    }

    log.info(`Generating container`)
    await generateContainer({
      containerVersion,
      nativeAppName,
      platformPath: Platform.currentPlatformVersionPath,
      generator: createContainerGenerator(platform, config),
      plugins: _.map(nativeDependenciesArray, d => Dependency.fromString(d)),
      miniapps,
      workingFolder: `${Platform.rootDirectory}/containergen`,
      pluginsConfigurationDirectory: Platform.pluginsConfigurationDirectory,
      reactNativeAarsPath: `${Platform.manifestDirectory}/react-native_aars`
    })
  } catch (e) {
    log.error(`runLocalContainerGen failed: ${e}`)
    throw e
  }
}

// Run container generator using the Cauldron, given a native application descriptor
export async function runCauldronContainerGen (
napDescriptor: NativeApplicationDescriptor,
version: string, {
  publish
}: {
  publish?: boolean
} = {}) {
  try {
    const plugins = await cauldron.getNativeDependencies(napDescriptor)
    const miniapps = await cauldron.getContainerMiniApps(napDescriptor)

    // Retrieve generator configuration (which for now only contains publication URL config)
    // only if caller of this method wants to publish the generated container
    let config
    if (publish) {
      config = await cauldron.getConfig(napDescriptor)
    } else {
      log.info('Container publication is disabled. Will generate the container locally.')
    }

    await generateContainer({
      containerVersion: version,
      nativeAppName: napDescriptor.name,
      platformPath: Platform.currentPlatformVersionPath,
      generator: createContainerGenerator(napDescriptor.platform, config ? config.containerGenerator : undefined),
      plugins,
      miniapps,
      workingFolder: `${Platform.rootDirectory}/containergen`,
      pluginsConfigurationDirectory: Platform.pluginsConfigurationDirectory,
      reactNativeAarsPath: `${Platform.manifestDirectory}/react-native_aars`
    })
  } catch (e) {
    log.error(`runCauldronContainerGen failed: ${e}`)
    throw e
  }
}

export async function performCodePushOtaUpdate (
napDescriptor: NativeApplicationDescriptor,
miniApps: Array<Dependency>, {
  force,
  codePushAppName,
  codePushDeploymentName,
  codePushPlatformName,
  codePushTargetVersionName,
  codePushIsMandatoryRelease,
  codePushRolloutPercentage
}: {
  force: boolean,
  codePushAppName: string,
  codePushDeploymentName: string,
  codePushPlatformName: 'android' | 'ios',
  codePushTargetVersionName: string,
  codePushIsMandatoryRelease: boolean,
  codePushRolloutPercentage: string
} = {}) {
  const plugins = await cauldron.getNativeDependencies(napDescriptor)

  const codePushPlugin = _.find(plugins, p => p.name === 'react-native-code-push')
  if (!codePushPlugin) {
    throw new Error('react-native-code-push plugin is not in native app !')
  }

  const workingFolder = `${Platform.rootDirectory}/CompositeOta`
  const codePushMiniapps : Array<Array<string>> = await cauldron.getCodePushMiniApps(napDescriptor)
  const latestCodePushedMiniApps : Array<Dependency> = _.map(codePushMiniapps.pop(), Dependency.fromString)

  // We need to include, in this CodePush bundle, all the MiniApps that were part
  // of the previous CodePush. We will override versions of the MiniApps with
  // the one provided to this function, and keep other ones intact.
  // For example, if previous CodePush bundle was containing MiniAppOne@1.0.0 and
  // MiniAppTwo@1.0.0 and this method is called to CodePush MiniAppOne@2.0.0, then
  // the bundle we will push will container MiniAppOne@2.0.0 and MiniAppTwo@1.0.0.
  // If this the first ever CodePush bundle for this specific native application version
  // then the reference miniapp versions are the one from the container.
  let referenceMiniAppsToCodePush : Array<Dependency> = latestCodePushedMiniApps
  if (!referenceMiniAppsToCodePush || referenceMiniAppsToCodePush.length === 0) {
    referenceMiniAppsToCodePush = await cauldron.getContainerMiniApps(napDescriptor)
  }

  const miniAppsToCodePush = _.unionBy(
    miniApps, referenceMiniAppsToCodePush, x => x.withoutVersion().toString())

  // TODO : Compatibility checking !

  await generateMiniAppsComposite(miniAppsToCodePush, workingFolder)
  process.chdir(workingFolder)

  codePushDeploymentName = codePushDeploymentName || await askUserForCodePushDeploymentName(napDescriptor)
  codePushAppName = codePushAppName || await askUserForCodePushAppName()
  codePushPlatformName = codePushPlatformName || await askUserForCodePushPlatformName(napDescriptor.platform)

  const codePushCommands = new CodePushCommands(`${Platform.currentPlatformVersionPath}/node_modules/.bin/code-push`)

  await codePushCommands.releaseReact(
    codePushAppName,
    codePushPlatformName, {
      targetBinaryVersion: codePushTargetVersionName,
      mandatory: codePushIsMandatoryRelease,
      deploymentName: codePushDeploymentName,
      rolloutPercentage: codePushRolloutPercentage
    })

  await cauldron.addCodePushMiniApps(napDescriptor, miniAppsToCodePush)
}

async function askUserForCodePushDeploymentName (napDescriptor: NativeApplicationDescriptor) {
  const config = await cauldron.getConfig(napDescriptor)
  const hasCodePushDeploymentsConfig = config && config.codePush && config.codePush.deployments
  const choices = hasCodePushDeploymentsConfig ? config.codePush.deployments : undefined

  const { userSelectedDeploymentName } = await inquirer.prompt({
    type: choices ? 'list' : 'input',
    name: 'userSelectedDeploymentName',
    message: 'Deployment name',
    choices
  })

  return userSelectedDeploymentName
}

async function askUserForCodePushAppName (defaultAppName) {
  const { userSelectedCodePushAppName } = await inquirer.prompt({
    type: 'input',
    name: 'userSelectedCodePushAppName',
    message: 'Application name',
    default: defaultAppName
  })
  return userSelectedCodePushAppName
}

async function askUserForCodePushPlatformName (defaultPlatformName) {
  const { userSelectedCodePushPlatformName }: { userSelectedCodePushPlatformName: 'android' | 'ios' } = await inquirer.prompt({
    type: 'input',
    name: 'userSelectedCodePushPlatformName',
    message: 'Platform name',
    default: defaultPlatformName
  })
  return userSelectedCodePushPlatformName
}
