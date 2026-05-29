# mengban-skin-converter

批量把宠物皮肤目录里的 `pet.json` 和 WebP 皮肤图转换为 `.mengban-skin` 文件。

生成格式与宠物项目当前读取逻辑一致：

- 文件头：`MSKIN1\0`
- 加密：`AES-256-GCM`
- AAD：`MSKIN1\0`
- 明文 JSON schema：`mengban-skin-pack/v1`
- 内容：`pet.json` 原始对象 + base64 后的 `skin.webp`

## 使用

### 页面转换

直接打开本地页面：

```bash
cd mengban-skin-converter
python3 -m http.server 4173 -d web
```

然后访问 `http://127.0.0.1:4173/`，可以上传散文件、文件夹或 `.zip` 压缩包。页面会批量识别每组 `pet.json` 和 WebP 贴图，单个结果直接下载 `.mengban-skin`，多个结果会打包成 `mengban-skin-output.zip`。

贴图文件匹配顺序：

1. `pet.json` 里的 `spritesheetPath`
2. 同目录下的 `spritesheet.webp`
3. 同目录下的 `skin.webp`

### 命令行转换

```bash
cd mengban-skin-converter
npm run convert -- ../skins --out ./out --recursive
```

单个文件转换：

```bash
npm run convert -- --pet ./cat/pet.json --webp ./cat/skin.webp --out ./out/cat.mengban-skin
```

批量转换时，工具会扫描输入目录里的 `pet.json`：

- 默认只扫描输入目录第一层
- 加 `--recursive` 后递归扫描子目录
- WebP 文件路径优先读取 `pet.json` 的 `spritesheetPath`
- 如果没有 `spritesheetPath`，会依次尝试同目录下的 `spritesheet.webp` 和 `skin.webp`
- 输出文件名使用 `pet.json` 的 `id`，自动清理成安全文件名

## 选项

```text
--pet <file>       转换单个 pet.json
--webp <file>      与 --pet 配套使用的 WebP 文件
--out <path>       批量模式为输出目录；单文件模式可传文件或目录
--recursive        递归扫描 pet.json
--overwrite        覆盖已存在的 .mengban-skin
--dry-run          只打印转换计划，不写文件
--verify           写入后解密校验，默认开启
--no-verify        跳过解密校验
--help             查看帮助
```

## pet.json 示例

```json
{
  "id": "cabbie",
  "displayName": "Cabbie",
  "description": "A pet skin",
  "spritesheetPath": "skin.webp",
  "kind": "pet"
}
```
