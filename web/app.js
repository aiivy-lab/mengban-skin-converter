const MAGIC = new TextEncoder().encode('MSKIN1\0')
const SCHEMA = 'mengban-skin-pack/v1'
const KEY_MATERIAL = 'mengban-skin-container/v1/default-local-key'
const CRC_TABLE = makeCrcTable()

const state = {
  files: [],
  jobs: [],
  issues: []
}

const elements = {
  dropZone: document.querySelector('#dropZone'),
  folderInput: document.querySelector('#fileInput'),
  plainFileInput: document.querySelector('#plainFileInput'),
  chooseFilesButton: document.querySelector('#chooseFilesButton'),
  chooseFolderButton: document.querySelector('#chooseFolderButton'),
  convertButton: document.querySelector('#convertButton'),
  clearButton: document.querySelector('#clearButton'),
  overwriteNames: document.querySelector('#overwriteNames'),
  skinCount: document.querySelector('#skinCount'),
  fileCount: document.querySelector('#fileCount'),
  issueCount: document.querySelector('#issueCount'),
  statusText: document.querySelector('#statusText'),
  resultsList: document.querySelector('#resultsList'),
  resultTemplate: document.querySelector('#resultTemplate')
}

elements.chooseFilesButton.addEventListener('click', () => elements.plainFileInput.click())
elements.chooseFolderButton.addEventListener('click', () => elements.folderInput.click())
elements.clearButton.addEventListener('click', clearAll)
elements.convertButton.addEventListener('click', convertAll)
elements.folderInput.addEventListener('change', (event) => readPickedFiles(event.target.files))
elements.plainFileInput.addEventListener('change', (event) => readPickedFiles(event.target.files))

for (const eventName of ['dragenter', 'dragover']) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    elements.dropZone.classList.add('dragging')
  })
}

for (const eventName of ['dragleave', 'drop']) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    elements.dropZone.classList.remove('dragging')
  })
}

elements.dropZone.addEventListener('drop', (event) => {
  readPickedFiles(event.dataTransfer.files)
})

elements.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    elements.plainFileInput.click()
  }
})

async function readPickedFiles(fileList) {
  const picked = Array.from(fileList || [])
  if (picked.length === 0) return

  setStatus('正在读取上传资源...')
  const expanded = []
  const issues = []

  for (const file of picked) {
    const relativePath = normalizePath(file.webkitRelativePath || file.name)
    if (file.name.toLowerCase().endsWith('.zip')) {
      try {
        const zipFiles = await readZipEntries(await file.arrayBuffer(), file.name)
        expanded.push(...zipFiles)
      } catch (error) {
        issues.push({ title: file.name, message: `压缩包读取失败：${error.message}` })
      }
      continue
    }

    if (isUsefulInput(relativePath)) {
      expanded.push({
        path: relativePath,
        name: file.name,
        bytes: await file.arrayBuffer()
      })
    }
  }

  state.files = expanded
  const analysis = await analyzeFiles(expanded)
  state.jobs = analysis.jobs
  state.issues = [...issues, ...analysis.issues]
  render()
}

async function analyzeFiles(files) {
  const byPath = new Map(files.map((file) => [normalizePath(file.path).toLowerCase(), file]))
  const jsonFiles = files.filter((file) => basename(file.path).toLowerCase().endsWith('.json'))
  const jobs = []
  const issues = []

  for (const petFile of jsonFiles) {
    try {
      const petJson = JSON.parse(decodeUtf8(petFile.bytes))

      const baseDir = dirname(petFile.path)
      const imageFile = findImageFile({ petJson, petJsonPath: petFile.path, baseDir, files, byPath })
      if (!looksLikeSkinJson(petJson, petFile.path) && !isStrongImageMatch({ petJson, petJsonPath: petFile.path, imageFile, baseDir })) continue

      const skinId = getSkinId(petJson, basename(baseDir) || basename(petFile.path, '.json') || 'pet-skin')

      if (!imageFile) {
        issues.push({
          title: skinId,
          message: `${petFile.path} 没有找到图片。已尝试 JSON 内的图片路径、spritesheet/skin WebP 或 PNG、同目录唯一图片、同名或同 id 图片。`
        })
        continue
      }

      jobs.push({
        id: skinId,
        outputName: `${sanitizeFileStem(skinId)}.mengban-skin`,
        petJson,
        petPath: petFile.path,
        imagePath: imageFile.path,
        imageBytes: imageFile.bytes
      })
    } catch (error) {
      issues.push({ title: petFile.path, message: `JSON 解析失败：${error.message}` })
    }
  }

  if (jsonFiles.length === 0 && files.length > 0) {
    issues.push({ title: '没有找到 JSON', message: '请上传包含皮肤 JSON 和 WebP/PNG 图的文件夹或压缩包。' })
  } else if (jobs.length === 0 && issues.length === 0 && files.length > 0) {
    issues.push({ title: '没有可转换资源', message: '已读取 JSON，但没有识别到皮肤描述或可配对的图片。' })
  }

  return { jobs, issues }
}

function findImageFile({ petJson, petJsonPath, baseDir, files, byPath }) {
  const candidates = getSpritesheetPathCandidates(petJson)
  for (const candidate of candidates) {
    const candidatePath = normalizePath(joinPath(baseDir, candidate)).toLowerCase()
    if (byPath.has(candidatePath)) return byPath.get(candidatePath)
  }

  const siblingImages = files.filter((file) => {
    return dirname(file.path) === baseDir && isSupportedSkinImagePath(file.path)
  })
  if (siblingImages.length === 1) return siblingImages[0]

  const preferredStems = [
    basename(petJsonPath, '.json'),
    petJson?.id,
    petJson?.name,
    petJson?.displayName,
    basename(baseDir)
  ].map(normalizeMatchToken).filter(Boolean)

  return siblingImages.find((file) => {
    const imageStem = normalizeMatchToken(basename(file.path, imageExtension(file.path)))
    return preferredStems.includes(imageStem)
  }) || null
}

function isStrongImageMatch({ petJson, petJsonPath, imageFile, baseDir }) {
  if (!imageFile) return false
  for (const candidate of extractImagePathCandidates(petJson)) {
    if (normalizePath(joinPath(baseDir, candidate)).toLowerCase() === normalizePath(imageFile.path).toLowerCase()) return true
  }

  const preferredStems = [
    basename(petJsonPath, '.json'),
    petJson?.id,
    petJson?.name,
    petJson?.displayName,
    basename(baseDir)
  ].map(normalizeMatchToken).filter(Boolean)
  const imageStem = normalizeMatchToken(basename(imageFile.path, imageExtension(imageFile.path)))
  return preferredStems.includes(imageStem)
}

async function convertAll() {
  if (state.jobs.length === 0) return
  elements.convertButton.disabled = true
  setStatus('正在加密并生成文件...')

  try {
    const usedNames = new Map()
    const outputs = []
    for (const job of state.jobs) {
      const outputName = makeOutputName(job.outputName, usedNames, elements.overwriteNames.checked)
      const bytes = await createMengbanSkinBytes({ petJson: job.petJson, skinImage: job.imageBytes, imagePath: job.imagePath })
      outputs.push({ name: outputName, bytes })
    }

    if (outputs.length === 1) {
      downloadBlob(new Blob([outputs[0].bytes], { type: 'application/octet-stream' }), outputs[0].name)
    } else {
      const zipBytes = createZip(outputs.map((output) => ({
        name: output.name,
        bytes: output.bytes
      })))
      downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), 'mengban-skin-output.zip')
    }

    setStatus(`完成 ${outputs.length} 个文件`)
    render('done')
  } catch (error) {
    setStatus(`转换失败：${error.message}`)
    elements.convertButton.disabled = false
  }
}

async function createMengbanSkinBytes({ petJson, skinImage, imagePath }) {
  const imageName = getPackedSkinImageName(imagePath)
  const payload = encodeUtf8(JSON.stringify({
    schema: SCHEMA,
    files: {
      'pet.json': petJson,
      [imageName]: arrayBufferToBase64(skinImage)
    }
  }))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await getCryptoKey()
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: MAGIC,
    tagLength: 128
  }, key, payload))

  return concatUint8(MAGIC, nonce, encrypted)
}

async function getCryptoKey() {
  const hash = await crypto.subtle.digest('SHA-256', encodeUtf8(KEY_MATERIAL))
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt'])
}

function render(doneState = null) {
  elements.skinCount.textContent = String(state.jobs.length)
  elements.fileCount.textContent = String(state.files.length)
  elements.issueCount.textContent = String(state.issues.length)
  elements.convertButton.disabled = state.jobs.length === 0
  elements.resultsList.innerHTML = ''
  elements.resultsList.classList.toggle('empty', state.jobs.length === 0 && state.issues.length === 0)

  if (state.jobs.length === 0 && state.issues.length === 0) {
    elements.resultsList.innerHTML = '<div class="empty-state"><strong>还没有皮肤资源</strong><span>每个目录至少需要一个皮肤 JSON 和一个 WebP/PNG 图。</span></div>'
    setStatus('等待上传资源')
    return
  }

  for (const job of state.jobs) {
    elements.resultsList.appendChild(createResultCard({
      title: job.outputName,
      meta: `${job.petPath} + ${job.imagePath}`,
      status: doneState === 'done' ? '已生成' : '就绪',
      kind: doneState === 'done' ? 'done' : 'ready'
    }))
  }

  for (const issue of state.issues) {
    elements.resultsList.appendChild(createResultCard({
      title: issue.title,
      meta: issue.message,
      status: '需要处理',
      kind: 'error'
    }))
  }

  if (doneState !== 'done') {
    setStatus(state.jobs.length > 0 ? `找到 ${state.jobs.length} 组可转换资源` : '没有可转换资源')
  }
}

function createResultCard({ title, meta, status, kind }) {
  const node = elements.resultTemplate.content.firstElementChild.cloneNode(true)
  node.classList.add(kind)
  node.querySelector('.result-title').textContent = title
  node.querySelector('.result-meta').textContent = meta
  node.querySelector('.result-status').textContent = status
  return node
}

function clearAll() {
  state.files = []
  state.jobs = []
  state.issues = []
  elements.folderInput.value = ''
  elements.plainFileInput.value = ''
  render()
}

function setStatus(text) {
  elements.statusText.textContent = text
}

async function readZipEntries(arrayBuffer, archiveName) {
  const bytes = new Uint8Array(arrayBuffer)
  const entries = []
  const eocdOffset = findEndOfCentralDirectory(bytes)
  if (eocdOffset < 0) {
    throw new Error('没有找到 ZIP 中央目录')
  }

  const entryCount = readU16(bytes, eocdOffset + 10)
  let centralOffset = readU32(bytes, eocdOffset + 16)

  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, centralOffset) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏')
    }

    const method = readU16(bytes, centralOffset + 10)
    const compressedSize = readU32(bytes, centralOffset + 20)
    const uncompressedSize = readU32(bytes, centralOffset + 24)
    const nameLength = readU16(bytes, centralOffset + 28)
    const extraLength = readU16(bytes, centralOffset + 30)
    const commentLength = readU16(bytes, centralOffset + 32)
    const localOffset = readU32(bytes, centralOffset + 42)
    const nameStart = centralOffset + 46
    const name = normalizePath(decodeUtf8(bytes.slice(nameStart, nameStart + nameLength)))

    if (method !== 0 && method !== 8) {
      throw new Error(`${name} 使用了不支持的压缩方法 ${method}`)
    }

    if (readU32(bytes, localOffset) !== 0x04034b50) {
      throw new Error(`${name} 的本地文件头损坏`)
    }

    const localNameLength = readU16(bytes, localOffset + 26)
    const localExtraLength = readU16(bytes, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.slice(dataStart, dataStart + compressedSize)
    let content
    if (method === 0) {
      content = compressed
    } else {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      content = new Uint8Array(await new Response(stream).arrayBuffer())
    }

    if (content.length !== uncompressedSize) {
      throw new Error(`${name} 解压后大小不一致`)
    }

    if (!name.endsWith('/') && isUsefulInput(name)) {
      entries.push({
        path: normalizePath(`${archiveName.replace(/\.zip$/i, '')}/${name}`),
        name: basename(name),
        bytes: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)
      })
    }

    centralOffset = nameStart + nameLength + extraLength + commentLength
  }

  return entries
}

function findEndOfCentralDirectory(bytes) {
  const minOffset = Math.max(0, bytes.length - 0xffff - 22)
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) {
      return offset
    }
  }
  return -1
}

function createZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encodeUtf8(file.name)
    const fileBytes = new Uint8Array(file.bytes)
    const crc = crc32(fileBytes)
    const local = new Uint8Array(30 + nameBytes.length)
    writeU32(local, 0, 0x04034b50)
    writeU16(local, 4, 20)
    writeU16(local, 6, 0)
    writeU16(local, 8, 0)
    writeU16(local, 10, 0)
    writeU16(local, 12, 0)
    writeU32(local, 14, crc)
    writeU32(local, 18, fileBytes.length)
    writeU32(local, 22, fileBytes.length)
    writeU16(local, 26, nameBytes.length)
    writeU16(local, 28, 0)
    local.set(nameBytes, 30)
    localParts.push(local, fileBytes)

    const central = new Uint8Array(46 + nameBytes.length)
    writeU32(central, 0, 0x02014b50)
    writeU16(central, 4, 20)
    writeU16(central, 6, 20)
    writeU16(central, 8, 0)
    writeU16(central, 10, 0)
    writeU16(central, 12, 0)
    writeU16(central, 14, 0)
    writeU32(central, 16, crc)
    writeU32(central, 20, fileBytes.length)
    writeU32(central, 24, fileBytes.length)
    writeU16(central, 28, nameBytes.length)
    writeU16(central, 30, 0)
    writeU16(central, 32, 0)
    writeU16(central, 34, 0)
    writeU16(central, 36, 0)
    writeU32(central, 38, 0)
    writeU32(central, 42, offset)
    central.set(nameBytes, 46)
    centralParts.push(central)

    offset += local.length + fileBytes.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  writeU32(end, 0, 0x06054b50)
  writeU16(end, 8, files.length)
  writeU16(end, 10, files.length)
  writeU32(end, 12, centralSize)
  writeU32(end, 16, offset)
  writeU16(end, 20, 0)

  return concatUint8(...localParts, ...centralParts, end)
}

function makeOutputName(name, usedNames, autoNumber) {
  const cleanName = sanitizeFileStem(name.replace(/\.mengban-skin$/i, '')) + '.mengban-skin'
  const count = usedNames.get(cleanName) || 0
  usedNames.set(cleanName, count + 1)
  if (count === 0 || !autoNumber) return cleanName
  return cleanName.replace(/\.mengban-skin$/i, `-${count + 1}.mengban-skin`)
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function sanitizeFileStem(value) {
  const cleaned = String(value || 'pet-skin').replace(/[^a-zA-Z0-9_-]/g, '-')
  return cleaned || 'pet-skin'
}

function isUsefulInput(filePath) {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.json') || isSupportedSkinImagePath(lower) || lower.endsWith('.zip')
}

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function dirname(filePath) {
  const normalized = normalizePath(filePath)
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : ''
}

function basename(filePath, extension = '') {
  const normalized = normalizePath(filePath)
  const index = normalized.lastIndexOf('/')
  const name = index >= 0 ? normalized.slice(index + 1) : normalized
  return extension && name.toLowerCase().endsWith(extension.toLowerCase())
    ? name.slice(0, -extension.length)
    : name
}

function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'))
}

function getSkinId(petJson, fallback = 'pet-skin') {
  return petJson?.id || petJson?.name || petJson?.displayName || fallback || 'pet-skin'
}

function getSpritesheetPathCandidates(petJson) {
  return uniqueStrings([
    ...extractImagePathCandidates(petJson),
    'spritesheet.webp',
    'skin.webp',
    'spritesheet.png',
    'skin.png'
  ])
}

function extractWebpPathCandidates(value, depth = 0) {
  return extractImagePathCandidates(value, depth)
}

function extractImagePathCandidates(value, depth = 0) {
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

function looksLikeSkinJson(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (basename(filePath).toLowerCase() === 'pet.json') return true
  if (extractImagePathCandidates(value).length > 0) return true
  return ['sprites', 'frames', 'animations', 'kind', 'description'].some((key) => key in value)
}

function isSupportedSkinImagePath(value) {
  const lower = String(value || '').toLowerCase()
  return lower.endsWith('.webp') || lower.endsWith('.png')
}

function imageExtension(value) {
  return String(value || '').toLowerCase().endsWith('.png') ? '.png' : '.webp'
}

function getPackedSkinImageName(imagePath) {
  return imageExtension(imagePath) === '.png' ? 'skin.png' : 'skin.webp'
}

function normalizeMatchToken(value) {
  return String(value || '').trim().toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '')
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

function encodeUtf8(value) {
  return new TextEncoder().encode(value)
}

function decodeUtf8(value) {
  return new TextDecoder().decode(value)
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function concatUint8(...parts) {
  const arrays = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part))
  const total = arrays.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of arrays) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function makeCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

render()
