#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import {
  extractImagePathCandidates,
  getSkinId,
  getSpritesheetPathCandidates,
  isSupportedSkinImagePath,
  packMengbanSkin,
  readAndVerifyMengbanSkin,
  sanitizeFileStem
} from '../src/mengbanSkin.js'

const usage = `
Usage:
  mengban-skin <input-dir> [--out <output-dir>] [--recursive] [--overwrite]
  mengban-skin --pet <skin.json> --image <skin.webp|skin.png> --out <file-or-dir> [--overwrite]

Examples:
  npm run convert -- ./skins --out ./out --recursive
  npm run convert -- --pet ./cat/skin.json --image ./cat/skin.png --out ./out/cat.mengban-skin

Options:
  --pet <file>       Convert one skin JSON file.
  --image <file>     WebP or PNG image used with --pet.
  --webp <file>      Alias for --image, kept for compatibility.
  --out <path>       Output directory for batch mode, or file/directory for single mode.
  --recursive        Recursively scan subdirectories for skin JSON files.
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
  const optionsWithValues = new Set(['--pet', '--image', '--webp', '--out'])
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

async function findFilesByExtension(root, extension, { recursive }) {
  const found = []
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) {
      found.push(entryPath)
      continue
    }
    if (recursive && entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      found.push(...await findFilesByExtension(entryPath, extension, { recursive }))
    }
  }

  return found
}

async function makeJobFromPetJson(petJsonPath, outRoot, petJson = null) {
  const raw = await readFile(petJsonPath, 'utf8')
  petJson ||= JSON.parse(raw)
  const petDir = path.dirname(petJsonPath)
  const imagePath = await findBestImageForJson({ petJson, petJsonPath })
  if (!imagePath) {
    throw new Error(`${petJsonPath}: image not found. Tried JSON image references, spritesheet/skin WebP or PNG, same-folder image, and same-name/id image.`)
  }

  const id = getSkinId(petJson, path.basename(petDir))
  const outPath = path.resolve(outRoot, `${sanitizeFileStem(id)}.mengban-skin`)
  return { petJsonPath, webpPath: imagePath, imagePath, outPath, id }
}

async function findBestImageForJson({ petJson, petJsonPath }) {
  const petDir = path.dirname(petJsonPath)
  for (const candidate of getSpritesheetPathCandidates(petJson)) {
    const candidatePath = path.resolve(petDir, candidate)
    if (await exists(candidatePath)) {
      return candidatePath
    }
  }

  const siblingImages = await findSiblingImages(petDir)
  if (siblingImages.length === 1) {
    return siblingImages[0]
  }

  const preferredStems = [
    path.basename(petJsonPath, path.extname(petJsonPath)),
    getSkinId(petJson, ''),
    petJson?.displayName,
    path.basename(petDir)
  ].map(normalizeMatchToken).filter(Boolean)

  for (const imagePath of siblingImages) {
    const imageStem = normalizeMatchToken(path.basename(imagePath, path.extname(imagePath)))
    if (preferredStems.includes(imageStem)) {
      return imagePath
    }
  }

  return null
}

function isStrongImageMatch({ petJson, petJsonPath, imagePath }) {
  if (!imagePath) return false
  const petDir = path.dirname(petJsonPath)
  const resolvedImagePath = path.resolve(imagePath)

  for (const candidate of extractImagePathCandidates(petJson)) {
    if (path.resolve(petDir, candidate) === resolvedImagePath) return true
  }

  const preferredStems = [
    path.basename(petJsonPath, path.extname(petJsonPath)),
    petJson?.id,
    petJson?.name,
    petJson?.displayName,
    path.basename(petDir)
  ].map(normalizeMatchToken).filter(Boolean)
  const imageStem = normalizeMatchToken(path.basename(imagePath, path.extname(imagePath)))
  return preferredStems.includes(imageStem)
}

async function findSiblingImages(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && isSupportedSkinImagePath(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
}

function looksLikeSkinJson(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (path.basename(filePath).toLowerCase() === 'pet.json') return true
  if (extractImagePathCandidates(value).length > 0) return true
  return ['sprites', 'frames', 'animations', 'kind', 'description'].some((key) => key in value)
}

function normalizeMatchToken(value) {
  return String(value || '').trim().toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '')
}

async function makeJobs() {
  const petPath = readOption('--pet')
  const imagePath = readOption('--image') || readOption('--webp')
  const outPath = readOption('--out')

  if (petPath || imagePath) {
    if (!petPath || !imagePath || !outPath) {
      throw new Error('--pet, --image and --out are required together')
    }

    const petJson = JSON.parse(await readFile(path.resolve(petPath), 'utf8'))
    const outputLooksLikeFile = path.extname(outPath).toLowerCase() === '.mengban-skin'
    const finalOutPath = outputLooksLikeFile
      ? outPath
      : path.join(outPath, `${sanitizeFileStem(getSkinId(petJson, path.basename(path.dirname(petPath))))}.mengban-skin`)
    return [{
      petJsonPath: path.resolve(petPath),
      webpPath: path.resolve(imagePath),
      imagePath: path.resolve(imagePath),
      outPath: path.resolve(finalOutPath),
      id: getSkinId(petJson, path.basename(path.dirname(petPath)))
    }]
  }

  const inputDir = firstPositional()
  if (!inputDir) {
    throw new Error('input directory is required')
  }

  const resolvedInputDir = path.resolve(inputDir)
  const outputDir = path.resolve(outPath || path.join(resolvedInputDir, 'mengban-skin-output'))
  const jsonFiles = await findFilesByExtension(resolvedInputDir, '.json', { recursive: hasFlag('--recursive') })
  const jobs = []
  for (const file of jsonFiles) {
    try {
      const json = JSON.parse(await readFile(file, 'utf8'))
      const imagePath = await findBestImageForJson({ petJson: json, petJsonPath: file })
      if (!looksLikeSkinJson(json, file) && !isStrongImageMatch({ petJson: json, petJsonPath: file, imagePath })) continue
      if (!imagePath) {
        console.error(`Skip ${file}: image not found. Tried JSON image references, spritesheet/skin WebP or PNG, same-folder image, and same-name/id image.`)
        continue
      }

      const id = getSkinId(json, path.basename(path.dirname(file)))
      const outPath = path.resolve(outputDir, `${sanitizeFileStem(id)}.mengban-skin`)
      jobs.push({ petJsonPath: file, webpPath: imagePath, imagePath, outPath, id })
    } catch (error) {
      console.error(`Skip ${file}: ${error.message}`)
    }
  }
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
    console.log('No convertible skin JSON + image pairs found.')
    return
  }

  const overwrite = hasFlag('--overwrite')
  const dryRun = hasFlag('--dry-run')
  const verify = !hasFlag('--no-verify')

  let successCount = 0
  let failureCount = 0
  for (const job of jobs) {
    if (dryRun) {
      console.log(`[dry-run] ${job.petJsonPath} + ${job.imagePath || job.webpPath} -> ${job.outPath}`)
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
