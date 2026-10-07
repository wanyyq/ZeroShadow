import fs from "node:fs"
import iconv from "iconv-lite"
import { encodeText } from "./src/encoding.js"

const LOG = "./.audit-enc-probe.log"
fs.writeFileSync(LOG, "")
const say = (m) => { fs.appendFileSync(LOG, `${Date.now() % 100000} ${m}\n`) }

for (const mb of [1, 2, 3, 4]) {
  const n = (mb * 1024 * 1024) / 4
  say(`start mb=${mb} n=${n}`)
  let s = Date.now()
  const text = "\uD83D\uDE00".repeat(n)
  say(`repeat ms=${Date.now() - s} units=${text.length}`)
  s = Date.now()
  const buf = iconv.encode(text, "big5")
  say(`encode ms=${Date.now() - s} bytes=${buf.length}`)
  s = Date.now()
  const back = iconv.decode(buf, "big5").replace(/^\uFEFF/, "")
  say(`decode ms=${Date.now() - s} chars=${back.length}`)
  s = Date.now()
  const r = encodeText(text, "big5")
  say(`encodeText ms=${Date.now() - s} buf=${r.buffer.length} unmappable=${(r.unmappable || []).length}`)
}
say("done")
