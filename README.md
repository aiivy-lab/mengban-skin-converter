# mengban-skin-converter

批量把宠物皮肤目录里的 JSON 描述文件和 WebP/PNG 皮肤图转换为 `.mengban-skin` 文件。

生成格式与宠物项目当前读取逻辑一致：

- 文件头：`MSKIN1\0`
- 加密：`AES-256-GCM`
- AAD：`MSKIN1\0`
- 明文 JSON schema：`mengban-skin-pack/v1`
- 内容：`pet.json` 原始对象 + base64 后的 `skin.webp` 或 `skin.png`

## 使用

### 页面转换

直接打开本地页面：

```bash
cd mengban-skin-converter
python3 -m http.server 4173 -d web
```

然后访问 `http://127.0.0.1:4173/`，可以上传散文件、文件夹或 `.zip` 压缩包。页面会批量识别每组皮肤 JSON 和 WebP/PNG 贴图，单个结果直接下载 `.mengban-skin`，多个结果会打包成 `mengban-skin-output.zip`。

贴图文件匹配顺序：

1. JSON 内任意字段里显式引用的 `.webp` 或 `.png` 路径，例如 `spritesheetPath`、`imagePath`、`texture.path`
2. 同目录下的 `spritesheet.webp`、`skin.webp`、`spritesheet.png`、`skin.png`
3. 同目录只有一张 WebP/PNG 时自动使用该图片
4. 同目录多张图片时，优先匹配 JSON 文件名、`id`、`name`、`displayName` 或目录名相同的图片

### 命令行转换

```bash
cd mengban-skin-converter
npm run convert -- ../skins --out ./out --recursive
```

单个文件转换：

```bash
npm run convert -- --pet ./cat/skin.json --image ./cat/skin.png --out ./out/cat.mengban-skin
```

批量转换时，工具会扫描输入目录里的 `.json`：

- 默认只扫描输入目录第一层
- 加 `--recursive` 后递归扫描子目录
- `pet.json` 会被直接视为皮肤描述；其他 JSON 需要包含 `.webp`/`.png` 引用、帧/动画等皮肤字段，或能和同名/同 id 图片明确配对
- 图片路径优先读取 JSON 内的 `.webp`/`.png` 引用
- 如果没有显式路径，会依次尝试同目录下的 `spritesheet.webp`、`skin.webp`、`spritesheet.png`、`skin.png`、唯一图片、同名/同 id 图片
- 输出文件名使用 JSON 的 `id`、`name`、`displayName` 或目录名，自动清理成安全文件名

## 选项

```text
--pet <file>       转换单个皮肤 JSON
--image <file>     与 --pet 配套使用的 WebP 或 PNG 文件
--webp <file>      --image 的兼容别名
--out <path>       批量模式为输出目录；单文件模式可传文件或目录
--recursive        递归扫描皮肤 JSON
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
  "spritesheetPath": "skin.png",
  "kind": "pet"
}
```
