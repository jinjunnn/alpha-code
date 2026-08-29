// REQ-123 / alpha-code#1177 — real-Chromium zero-egress probe (AC4 core evidence).
//
// This module is bundled by build.mjs (vite, the same @opencode-ai/app plugin the
// merged office-preview.test.ts uses) and loaded inside a REAL Electron BrowserWindow —
// production runtime is Chromium, not happy-dom. It imports the SAME production
// extraction functions the workbench wires (no re-implementation), builds a malicious
// OOXML corpus with the real @zip.js ZipWriter, and drives three arms whose results are
// read back by the Electron main process (which owns the network observer + sink server).
//
// Why real Chromium and not `bun test`: the baseline records that happy-dom REJECTS
// internal entities while Chromium EXPANDS them, and that renderer `fetch` is a global —
// zero imports still reaches the network. So grep / import-graph checks are a speed bump,
// not proof. The only honest AC4-zero-egress evidence is running the production chain in
// the production runtime with a network observer that has a proven positive control.

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { detectOoxmlContainer } from "./src/renderer/alpha-ui/artifact-workbench/renderers/ooxml"
import { officeTextExtractionOf } from "./src/renderer/alpha-ui/artifact-workbench/renderers/office-text"
import { buildXlsxWorkbook } from "./src/renderer/alpha-ui/artifact-workbench/renderers/xlsx-model"
import { parseOoxmlContentPart } from "./src/renderer/alpha-ui/artifact-workbench/renderers/ooxml-content"

const SINK = "http://127.0.0.1:38999"

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

type Entry = readonly [string, string]

async function zip(entries: readonly Entry[]): Promise<Uint8Array> {
  const out = new Uint8ArrayWriter()
  const writer = new ZipWriter(out, { useWebWorkers: false })
  for (const [name, body] of entries)
    await writer.add(name, new TextReader(body), { dataDescriptor: false, extendedTimestamp: false })
  await writer.close()
  return out.getData()
}

function contentTypes(mainPart: string, contentType: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="${CT_NS}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/${mainPart}" ContentType="${contentType}"/>` +
    `</Types>`
  )
}

function rootRels(mainPart: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/>` +
    `</Relationships>`
  )
}

const DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"

// ── Malicious payloads — every AC4 egress vector the ticket names ──────────────
// External entity referencing a local file (classic XXE file read).
const XXE_FILE = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`
// External entity over http (SSRF to the sink).
const XXE_HTTP = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "${SINK}/xxe-http-entity">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`
// External DTD (parameter-entity / SYSTEM DTD fetch).
const XXE_DTD = `<?xml version="1.0"?><!DOCTYPE w:document SYSTEM "${SINK}/external-dtd"><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>dtd</w:t></w:r></w:p></w:body></w:document>`
// Part text containing a URL, plus a rels target pointing at the sink (must never be fetched).
const URL_IN_TEXT = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>visit ${SINK}/url-in-text now</w:t></w:r></w:p></w:body></w:document>`
const RELS_TARGET_SINK = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${SINK}/rels-external-target" TargetMode="External"/></Relationships>`

type ArmResult = { arm: string; detail: unknown }

async function runProductionExtraction(): Promise<ArmResult[]> {
  const results: ArmResult[] = []

  // Each malicious docx: valid OPC shell, hostile word/document.xml (and one hostile rels).
  const cases: { name: string; entries: Entry[] }[] = [
    { name: "xxe-file-entity", entries: [
      ["[Content_Types].xml", contentTypes("word/document.xml", DOCX_CT)],
      ["_rels/.rels", rootRels("word/document.xml")],
      ["word/document.xml", XXE_FILE],
    ] },
    { name: "xxe-http-entity", entries: [
      ["[Content_Types].xml", contentTypes("word/document.xml", DOCX_CT)],
      ["_rels/.rels", rootRels("word/document.xml")],
      ["word/document.xml", XXE_HTTP],
    ] },
    { name: "external-dtd", entries: [
      ["[Content_Types].xml", contentTypes("word/document.xml", DOCX_CT)],
      ["_rels/.rels", rootRels("word/document.xml")],
      ["word/document.xml", XXE_DTD],
    ] },
    { name: "url-in-text-and-rels", entries: [
      ["[Content_Types].xml", contentTypes("word/document.xml", DOCX_CT)],
      ["_rels/.rels", rootRels("word/document.xml")],
      ["word/document.xml", URL_IN_TEXT],
      ["word/_rels/document.xml.rels", RELS_TARGET_SINK],
    ] },
  ]

  for (const c of cases) {
    const bytes = await zip(c.entries)
    const detection = await detectOoxmlContainer(bytes, { retainContentParts: true })
    const extraction = officeTextExtractionOf(detection.status === "detected" ? detection : undefined)
    results.push({
      arm: `production:${c.name}`,
      detail: {
        detectionStatus: detection.status,
        extraction: extraction ?? null,
      },
    })
  }
  return results
}

// Arm R: gate BYPASSED — hand the same hostile XML straight to Chromium DOMParser, to
// confirm the residual boundary the baseline claims (Chromium does not fetch external
// entities/DTD even when nothing stops it). This is what makes "the gate defends DoS,
// not XXE" a measured fact rather than an assumption.
function runRawDomParser(): ArmResult[] {
  const out: ArmResult[] = []
  const payloads: { name: string; xml: string }[] = [
    { name: "raw-xxe-file", xml: XXE_FILE },
    { name: "raw-xxe-http", xml: XXE_HTTP },
    { name: "raw-external-dtd", xml: XXE_DTD },
    // internal entity expansion — happy-dom rejects, Chromium expands (billion-laughs vector)
    { name: "raw-internal-entity", xml: `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "AAAAAAAAAA">]><r>&a;&a;&a;</r>` },
  ]
  for (const p of payloads) {
    let text = ""
    let parsererror = false
    let threw: string | null = null
    try {
      const doc = new DOMParser().parseFromString(p.xml, "application/xml")
      parsererror = doc.getElementsByTagName("parsererror").length > 0
      text = doc.documentElement?.textContent ?? ""
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    out.push({ arm: `raw:${p.name}`, detail: { parsererror, textLen: text.length, textSample: text.slice(0, 64), threw } })
  }
  return out
}

// Direct gate calls on the hostile payloads — proves the gate itself rejects (the "prove
// the harness can go red" arm: without the gate these strings would reach DOMParser).
function runGateDirect(): ArmResult[] {
  const out: ArmResult[] = []
  const enc = new TextEncoder()
  const payloads: { name: string; xml: string }[] = [
    { name: "gate-xxe-file", xml: XXE_FILE },
    { name: "gate-xxe-http", xml: XXE_HTTP },
    { name: "gate-external-dtd", xml: XXE_DTD },
    { name: "gate-url-in-text", xml: URL_IN_TEXT },
  ]
  for (const p of payloads) {
    const parsed = parseOoxmlContentPart(enc.encode(p.xml))
    out.push({ arm: `gate:${p.name}`, detail: parsed.ok ? { ok: true } : { ok: false, code: parsed.code, reason: parsed.reason } })
  }
  return out
}

// Positive control: an explicit fetch the sink MUST record. If this is silent, the whole
// "zero hits" verdict is a false negative and the run is void.
async function runPositiveControl(): Promise<ArmResult> {
  let ok = false
  let err: string | null = null
  try {
    const r = await fetch(`${SINK}/positive-control`, { method: "GET" })
    ok = r.ok
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  return { arm: "positive-control", detail: { fetchOk: ok, err } }
}

async function runXlsxProbe(): Promise<ArmResult> {
  // xlsx path uses buildXlsxWorkbook, a different code path than office-text. Feed it a
  // hostile worksheet part (external entity) via the real detect+retain chain.
  const XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
  const sheetHostile = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "${SINK}/xlsx-sheet-entity">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>`
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const wbRels = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  const bytes = await zip([
    ["[Content_Types].xml", contentTypes("xl/workbook.xml", XLSX_CT)],
    ["_rels/.rels", rootRels("xl/workbook.xml")],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", wbRels],
    ["xl/worksheets/sheet1.xml", sheetHostile],
  ])
  const detection = await detectOoxmlContainer(bytes, { retainContentParts: true })
  let wb: unknown = null
  if (detection.status === "detected" && detection.parts) wb = buildXlsxWorkbook(detection.parts)
  return { arm: "production:xlsx-hostile-sheet", detail: { detectionStatus: detection.status, workbook: wb } }
}

async function main(): Promise<void> {
  const all: ArmResult[] = []
  all.push(...runGateDirect())
  all.push(...runRawDomParser())
  all.push(...(await runProductionExtraction()))
  all.push(await runXlsxProbe())
  // Positive control runs LAST so a recorded hit proves the observer was live for the
  // whole window that preceded it.
  all.push(await runPositiveControl())
  ;(window as unknown as { __PROBE_RESULT__: unknown }).__PROBE_RESULT__ = { arms: all }
  ;(window as unknown as { __PROBE_DONE__: boolean }).__PROBE_DONE__ = true
}

;(window as unknown as { __RUN_PROBE__: () => Promise<void> }).__RUN_PROBE__ = main
