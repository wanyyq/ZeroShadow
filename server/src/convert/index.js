/**
 * convert/index.js —— 转换模块的对外入口，同时也是**内置转换器的注册点**。
 *
 * 想加一种新转换（比如 .docx → .pdf、.csv → .xlsx）：
 *   1. 在 `convert/converters/` 下新建模块，导出一个转换器对象（字段见 registry.js）；
 *   2. 在下面「内置转换器」里 import 进来并 `registerConverter(...)`；
 *   3. 给它的 labelKey 在 7 套 locale 里补上译文（不补也能用，会显示 label 里的中文）；
 *   4. （可选）在 `scripts/convert-test.mjs` 里加一条断言。
 *
 * 前端不需要任何改动：右键菜单的「转换」子项按 `/api/fs/convert/targets` 动态渲染。
 *
 * 注意模块加载顺序：注册必须在路由处理请求之前完成，而这里在 import 阶段就执行了，
 * 所以 `server/index.js` 只要 import 了本模块（经由 routes/fs.js）就一定是注册好的。
 */
import { registerConverter, convertersForExt, getConverter, listConverters, publicConverterList } from "./registry.js"
import { mdToTxt, TEXT_MAX_BYTES } from "./converters/md-to-txt.js"
import { mdToPdf } from "./converters/md-to-pdf.js"
import { pngToJpg, jpgToPng, IMAGE_MAX_BYTES } from "./converters/image.js"

// ===== 内置转换器（顺序即右键菜单里的显示顺序）=====
registerConverter(mdToTxt)
registerConverter(mdToPdf)
registerConverter(pngToJpg)
registerConverter(jpgToPng)

export {
  registerConverter,
  convertersForExt,
  getConverter,
  listConverters,
  publicConverterList,
  TEXT_MAX_BYTES,
  IMAGE_MAX_BYTES,
}
export { parseMarkdown, toPlainText } from "./markdown.js"
export { loadFont as loadPdfFont } from "./pdf/font.js"
export { layoutDocument } from "./pdf/layout.js"
export { buildPdf } from "./pdf/document.js"
