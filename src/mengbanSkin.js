import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MENGBAN_SKIN_MAGIC = Buffer.from('MSKIN1\0', 'binary')
export const MENGBAN_SKIN_SCHEMA = 'mengban-skin-pack/v1'
const keyMaterial = Buffer.from('mengban-skin-container/v1/default-local-key')
const key = createHash('sha256').update(keyMaterial).digest()

export function sanitizeFileStem(value) {
  const cleaned = String(value || 'pet-skin').replace(/[^a-zA-Z0-9_-]/g, '-')
  return cleaned || 'pet-skin'
}

export function getSpritesheetPath(petJson) {
  return petJson?.spritesheetPath || 'skin.webp'
}

export function getSpritesheetPathCandidates(petJson) {
  return [
    petJson?.spritesheetPath,
    'spritesheet.webp',
    'skin.webp'
  ].filter(Boolean)
}

export function createMengbanSkinPayload({ petJson, skinWebp }) {
  return Buffer.from(JSON.stringify({
    schema: MENGBAN_SKIN_SCHEMA,
    files: {
      'pet.json': petJson,
      'skin.webp': Buffer.from(skinWebp).toString('base64')
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

export async function packMengbanSkin({ petJsonPath, webpPath, outPath, overwrite = false }) {
  const resolvedPetJsonPath = path.resolve(petJsonPath)
  const resolvedWebpPath = path.resolve(webpPath)
  const resolvedOutPath = path.resolve(outPath)
  const petJson = JSON.parse(await readFile(resolvedPetJsonPath, 'utf8'))
  const skinWebp = await readFile(resolvedWebpPath)
  const payload = createMengbanSkinPayload({ petJson, skinWebp })
  const packed = encryptMengbanSkinPayload(payload)

  await mkdir(path.dirname(resolvedOutPath), { recursive: true })
  await writeFile(resolvedOutPath, packed, { flag: overwrite ? 'w' : 'wx' })

  return {
    id: petJson.id || path.basename(resolvedOutPath, '.mengban-skin'),
    petJsonPath: resolvedPetJsonPath,
    webpPath: resolvedWebpPath,
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
  if (!packageJson.files?.['pet.json'] || !packageJson.files?.['skin.webp']) {
    throw new Error('package is missing pet.json or skin.webp')
  }
  return packageJson
}
