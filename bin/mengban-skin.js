#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import {
  getSpritesheetPathCandidates,
  packMengbanSkin,
  readAndVerifyMengbanSkin,
  sanitizeFileStem
} from '../src/mengbanSkin.js'

const usage = `
Usage:
  mengban-skin <input-dir> [--out <output-dir>] [--recursive] [--overwrite]
  mengban-skin --pet <pet.json> --webp <skin.webp> --out <file-or-dir> [--overwrite]

Examples:
  npm run convert -- ./skins --out ./out --recursive
  npm run convert -- --pet ./cat/pet.json --webp ./cat/skin.webp --out ./out/cat.mengban-skin

Options:
  --pet <file>       Convert one pet.json file.
  --webp <file>      WebP spritesheet used with --pet.
  --out <path>       Output directory for batch mode, or file/directory for single mode.
  --recursive        Recursively scan subdirectories for pet.json files.
  --overwrite        Replace existing .mengban-skin files.
  --dry-run          Print planned conversions without writing files.
  --verify           Decrypt generated files after writing. Enabled by default.
  --no-verify        Skip decrypt verification.
  --help             Show help.
`

const args = process.argv.slice(2)

function hasFlag(name) {
  return args.includes(name)
}

function readOption(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function firstPositional() {
  const optionsWithValues = new Set(['--pet', '--webp', '--out'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('-')) {
      if (optionsWithValues.has(arg)) {
        index += 1
      }
      continue
    }
    return arg
  }
  return null
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function findPetJsonFiles(root, { recursive }) {
  const found = []
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isFile() && entry.name === 'pet.json') {
      found.push(entryPath)
      continue
    }
    if (recursive && entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      found.push(...await findPetJsonFiles(entryPath, { recursive }))
    }
  }

  return found
}

async function makeJobFromPetJson(petJsonPath, outRoot) {
  const raw = await readFile(petJsonPath, 'utf8')
  const petJson = JSON.parse(raw)
  const petDir = path.dirname(petJsonPath)
  let webpPath = null
  for (const candidate of getSpritesheetPathCandidates(petJson)) {
    const candidatePath = path.resolve(petDir, candidate)
    if (await exists(candidatePath)) {
      webpPath = candidatePath
      break
    }
  }
  if (!webpPath) {
    throw new Error(`${petJsonPath}: spritesheet not found. Tried: ${getSpritesheetPathCandidates(petJson).join(', ')}`)
  }

  const outPath = path.resolve(outRoot, `${sanitizeFileStem(petJson.id || path.basename(petDir))}.mengban-skin`)
  return { petJsonPath, webpPath, outPath, id: petJson.id || path.basename(petDir) }
}

async function makeJobs() {
  const petPath = readOption('--pet')
  const webpPath = readOption('--webp')
  const outPath = readOption('--out')

  if (petPath || webpPath) {
    if (!petPath || !webpPath || !outPath) {
      throw new Error('--pet, --webp and --out are required together')
    }

    const petJson = JSON.parse(await readFile(path.resolve(petPath), 'utf8'))
    const outputLooksLikeFile = path.extname(outPath).toLowerCase() === '.mengban-skin'
    const finalOutPath = outputLooksLikeFile
      ? outPath
      : path.join(outPath, `${sanitizeFileStem(petJson.id || path.basename(path.dirname(petPath)))}.mengban-skin`)
    return [{
      petJsonPath: path.resolve(petPath),
      webpPath: path.resolve(webpPath),
      outPath: path.resolve(finalOutPath),
      id: petJson.id || path.basename(path.dirname(petPath))
    }]
  }

  const inputDir = firstPositional()
  if (!inputDir) {
    throw new Error('input directory is required')
  }

  const resolvedInputDir = path.resolve(inputDir)
  const outputDir = path.resolve(outPath || path.join(resolvedInputDir, 'mengban-skin-output'))
  const petJsonFiles = await findPetJsonFiles(resolvedInputDir, { recursive: hasFlag('--recursive') })
  const jobs = await Promise.all(petJsonFiles.map((file) => makeJobFromPetJson(file, outputDir)))
  return uniquifyOutputPaths(jobs)
}

function uniquifyOutputPaths(jobs) {
  const used = new Map()
  return jobs.map((job) => {
    const parsed = path.parse(job.outPath)
    const count = used.get(job.outPath) || 0
    used.set(job.outPath, count + 1)

    if (count === 0) {
      return job
    }

    let outPath
    let suffix = count + 1
    do {
      outPath = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`)
      suffix += 1
    } while (used.has(outPath))

    used.set(outPath, 1)
    return { ...job, outPath }
  })
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(usage.trim())
    return
  }

  const jobs = await makeJobs()
  if (jobs.length === 0) {
    console.log('No pet.json files found.')
    return
  }

  const overwrite = hasFlag('--overwrite')
  const dryRun = hasFlag('--dry-run')
  const verify = !hasFlag('--no-verify')

  let successCount = 0
  let failureCount = 0
  for (const job of jobs) {
    if (dryRun) {
      console.log(`[dry-run] ${job.petJsonPath} + ${job.webpPath} -> ${job.outPath}`)
      continue
    }

    try {
      const result = await packMengbanSkin({ ...job, overwrite })
      if (verify) {
        await readAndVerifyMengbanSkin(result.outPath)
      }
      successCount += 1
      console.log(`Wrote ${result.outPath} (${result.bytes} bytes)`)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        console.error(`Skip existing file: ${job.outPath} (use --overwrite to replace it)`)
      } else {
        console.error(`Failed ${job.petJsonPath}: ${error.message}`)
      }
      failureCount += 1
    }
  }

  if (!dryRun && (successCount === 0 || failureCount > 0)) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
