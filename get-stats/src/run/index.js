const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const logger = require('../util/logger')
const getDirSize = require('./get-dir-size')
const collectStats = require('./collect-stats')
const collectDiffs = require('./collect-diffs')
const { diffRepoDir, statsAppDir } = require('../constants')

// stats that always tracked
const defaultStats = new Set(['buildDuration', 'nodeModulesSize'])

const objVal = (obj, keys = '') => {
  let curVal = obj

  for (const key of keys.split('.')) {
    curVal = curVal && typeof curVal === 'object' && curVal[key]
  }
  return curVal
}

async function runConfigs(
  configs = [],
  { statsConfig, mainRepoPkgPaths, diffRepoPkgPaths },
  diffing = false
) {
  const results = []

  for (const config of configs) {
    logger(`Running config: ${config.title}${diffing ? ' (diff)' : ''}`)

    // clean statsAppDir
    await fs.remove(statsAppDir)
    await fs.copy(path.join(diffRepoDir, '.stats-app'), statsAppDir)
    const origFiles = new Set(await fs.readdir(statsAppDir))

    let mainRepoStats
    let diffRepoStats
    let diffs

    for (const pkgPaths of [mainRepoPkgPaths, diffRepoPkgPaths]) {
      let curStats = {
        buildDuration: null,
        nodeModulesSize: null,
      }

      // remove any new files
      if (mainRepoStats) {
        logger('Cleaning stats-app')
        for (const file of await fs.readdir(statsAppDir)) {
          if (!origFiles.has(file)) {
            await fs.remove(path.join(statsAppDir, file))
          }
        }
      }

      // apply config files
      for (const configFile of config.configFiles || []) {
        const filePath = path.join(statsAppDir, configFile.path)
        await fs.writeFile(filePath, configFile.content, 'utf8')
      }

      // links local builds of the packages and installs dependencies
      await linkPkgs(statsAppDir, pkgPaths)

      if (!diffing) {
        curStats.nodeModulesSize = await getDirSize(
          path.join(statsAppDir, 'node_modules')
        )
      }

      const buildStart = new Date().getTime()
      await exec(`cd ${statsAppDir} && ${statsConfig.appBuildCommand}`)
      curStats.buildDuration = new Date().getTime() - buildStart

      if (diffing) {
        curStats = true
      } else {
        const collectedStats = await collectStats(config.filesToTrack)
        curStats = {
          ...curStats,
          ...collectedStats,
        }
      }

      if (mainRepoStats) {
        diffRepoStats = curStats

        if (!diffing && config.diff !== false) {
          for (const groupKey of Object.keys(curStats)) {
            if (defaultStats.has(groupKey)) continue
            let mainGroupTotal = 0
            let diffGroupTotal = 0

            Object.keys(curStats[groupKey]).forEach(itemKey => {
              diffGroupTotal = objVal(diffRepoStats, `${groupKey}!!${itemKey}`)
              mainGroupTotal =
                objVal(mainRepoStats, `${groupKey}!!${itemKey}`) || 0
            })

            if (mainGroupTotal !== diffGroupTotal) {
              logger('Detected change, running diff')
              diffs = await runConfigs(
                [
                  {
                    ...config,
                    configFiles: config.diffConfigFiles,
                  },
                ],
                {
                  statsConfig,
                  mainRepoPkgPaths,
                  diffRepoPkgPaths,
                },
                true
              )
              break
            }
          }
        }

        if (diffing) {
          // copy new files and get diff results
          return collectDiffs(config.filesToTrack, config.diffRenames)
        }
      } else {
        // set up diffing folder and copy initial files
        if (diffing)
          await collectDiffs(config.filesToTrack, config.diffRenames, true)
        /* eslint-disable-next-line */
        mainRepoStats = curStats
      }
    }

    logger(`Finished running: ${config.title}`)

    results.push({
      title: config.title,
      mainRepoStats,
      diffRepoStats,
      diffs,
    })
  }

  return results
}

async function linkPkgs(pkgDir = '', pkgPaths) {
  await fs.remove(path.join(pkgDir, 'node_modules'))

  const pkgJsonPath = path.join(pkgDir, 'package.json')
  const pkgData = require(pkgJsonPath)

  if (!pkgData.dependencies && !pkgData.devDependencies) return

  for (const pkg of pkgPaths.keys()) {
    const pkgPath = pkgPaths.get(pkg)

    if (pkgData.dependencies && pkgData.dependencies[pkg]) {
      pkgData.dependencies[pkg] = pkgPath
    } else if (pkgData.devDependencies && pkgData.devDependencies[pkg]) {
      pkgData.devDependencies[pkg] = pkgPath
    }
  }
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgData, null, 2), 'utf8')
  await exec(`cd ${pkgDir} && yarn install`)
}

module.exports = runConfigs
