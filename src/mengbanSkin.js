import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MENGBAN_SKIN_MAGIC = Buffer.from('MSKIN1\0', 'binary')
export const MENGBAN_SKIN_SCHEMA = 'mengban-skin-pack/v1'
export const SUPPORTED_SKIN_IMAGE_EXTENSIONS = ['.webp', '.png']
const keyMaterial = Buffer.from('mengban-skin-container/v1/default-local-key')
const key = createHash('sha256').update(keyMaterial).digest()

export function sanitizeFileStem(value) {
  const cleaned = String(value || 'pet-skin').replace(/[^a-zA-Z0-9_-]/g, '-')
  return cleaned || 'pet-skin'
}

export function getSkinId(petJson, fallback = 'pet-skin') {
  return petJson?.id || petJson?.name || petJson?.displayName || fallback || 'pet-skin'
}

export function getSpritesheetPath(petJson) {
  return getSpritesheetPathCandidates(petJson)[0] || 'skin.webp'
}

export function getSpritesheetPathCandidates(petJson) {
  return uniqueStrings([
    ...extractImagePathCandidates(petJson),
    'spritesheet.webp',
    'skin.webp',
    'spritesheet.png',
    'skin.png'
  ])
}

export function extractWebpPathCandidates(value, depth = 0) {
  return extractImagePathCandidates(value, depth)
}

export function extractImagePathCandidates(value, depth = 0) {
  if (!value || depth > 5) return []

  if (typeof value === 'string') {
    return isSupportedSkinImagePath(value) ? [value] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractImagePathCandidates(item, depth + 1))
  }

  if (typeof value !== 'object') return []

  const preferredKeys = [
    'spritesheetPath',
    'spriteSheetPath',
    'spritePath',
    'skinPath',
    'webpPath',
    'pngPath',
    'imageFile',
    'imagePath',
    'texturePath',
    'atlasPath',
    'filePath',
    'filename',
    'file',
    'path',
    'image',
    'texture',
    'src',
    'url'
  ]
  const candidates = []

  for (const key of preferredKeys) {
    candidates.push(...extractImagePathCandidates(value[key], depth + 1))
  }

  for (const [key, nested] of Object.entries(value)) {
    if (preferredKeys.includes(key)) continue
    candidates.push(...extractImagePathCandidates(nested, depth + 1))
  }

  return uniqueStrings(candidates)
}

export function isSupportedSkinImagePath(value) {
  const lower = String(value || '').toLowerCase()
  return SUPPORTED_SKIN_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export function getPackedSkinImageName(imagePath = 'skin.webp') {
  return path.extname(String(imagePath || '')).toLowerCase() === '.png' ? 'skin.png' : 'skin.webp'
}

function uniqueStrings(values) {
  const seen = new Set()
  const output = []
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return output
}

export function createMengbanSkinPayload({ petJson, skinImage, skinWebp, imagePath }) {
  const imageName = getPackedSkinImageName(imagePath)
  return Buffer.from(JSON.stringify({
    schema: MENGBAN_SKIN_SCHEMA,
    files: {
      'pet.json': petJson,
      [imageName]: Buffer.from(skinImage || skinWebp).toString('base64')
    }
  }))
}

export function encryptMengbanSkinPayload(payload, nonce = randomBytes(12)) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw new Error('nonce must be a 12-byte Buffer')
  }

  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(MENGBAN_SKIN_MAGIC)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MENGBAN_SKIN_MAGIC, nonce, ciphertext, tag])
}

export async function packMengbanSkin({ petJsonPath, webpPath, imagePath = webpPath, outPath, overwrite = false }) {
  const resolvedPetJsonPath = path.resolve(petJsonPath)
  const resolvedImagePath = path.resolve(imagePath)
  const resolvedOutPath = path.resolve(outPath)
  const petJson = JSON.parse(await readFile(resolvedPetJsonPath, 'utf8'))
  const skinImage = await readFile(resolvedImagePath)
  const payload = createMengbanSkinPayload({ petJson, skinImage, imagePath: resolvedImagePath })
  const packed = encryptMengbanSkinPayload(payload)

  await mkdir(path.dirname(resolvedOutPath), { recursive: true })
  await writeFile(resolvedOutPath, packed, { flag: overwrite ? 'w' : 'wx' })

  return {
    id: petJson.id || path.basename(resolvedOutPath, '.mengban-skin'),
    petJsonPath: resolvedPetJsonPath,
    webpPath: resolvedImagePath,
    imagePath: resolvedImagePath,
    outPath: resolvedOutPath,
    bytes: packed.length
  }
}

export function decryptMengbanSkinBytes(bytes) {
  const source = Buffer.from(bytes)
  if (source.length <= MENGBAN_SKIN_MAGIC.length + 12 || !source.subarray(0, MENGBAN_SKIN_MAGIC.length).equals(MENGBAN_SKIN_MAGIC)) {
    throw new Error('not a valid .mengban-skin file')
  }

  const nonceStart = MENGBAN_SKIN_MAGIC.length
  const cipherStart = nonceStart + 12
  const nonce = source.subarray(nonceStart, cipherStart)
  const ciphertextAndTag = source.subarray(cipherStart)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(MENGBAN_SKIN_MAGIC)
  decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.length - 16))
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const packageJson = JSON.parse(plaintext.toString('utf8'))

  if (packageJson.schema !== MENGBAN_SKIN_SCHEMA) {
    throw new Error(`unsupported schema: ${packageJson.schema}`)
  }

  return packageJson
}

export async function readAndVerifyMengbanSkin(filePath) {
  const bytes = await readFile(path.resolve(filePath))
  const packageJson = decryptMengbanSkinBytes(bytes)
  if (!packageJson.files?.['pet.json'] || (!packageJson.files?.['skin.webp'] && !packageJson.files?.['skin.png'])) {
    throw new Error('package is missing pet.json or skin image')
  }
  return packageJson
}
