import { api } from "./pages-api.js?v=practice-20261118"
// PTA 复刻版前端逻辑：对齐线上 exam-app 的请求序列与轮询节奏。
import { createEditor, setLanguage, setFontSize, setTabSize,
         getText, focusEditor } from "./vendor/cm.js"

const PSID = "2121133349609480192"
const EID = "2121142069793841152"
const DEFAULT_PSPPID = "8912116068004631298048"
const requestedProblemId = new URLSearchParams(location.search).get("problemSetProblemId")
const PSPPID = /^[0-9]{1,32}$/.test(requestedProblemId) ? requestedProblemId : DEFAULT_PSPPID

const COMPILER_META = {
  JAVAC:   { language: "Java", displayName: "javac", version: "21", ext: "java",
             compileCmd: "javac -encoding UTF8 $src",
             runCmd: "java -Dfile.encoding=UTF-8 -XX:+UseSerialGC Main" },
  PYTHON3: { language: "Python", displayName: "python3", version: "3", ext: "py",
             compileCmd: "", runCmd: "python $src" },
  NODE:    { language: "JavaScript", displayName: "node", version: "24", ext: "js",
             compileCmd: "", runCmd: "node $src" },
}

const LEGACY_JAVA_STARTER = `public class Main {
    public static void main(String[] args) {
    }
}`

const PENDING = new Set(["WAITING", "JUDGING", "REJUDGING"])

const $ = id => document.getElementById(id)
const state = {
  config: {}, psp: null,
  compiler: "JAVAC", testData: "", view: null,
  editorSettings: { fontSize: 14, tabSize: 4, theme: "github", keyMap: "", showWhitespace: true },
  saveTimer: null, saving: false, pollTimer: null, lastDetail: null,
}
const cacheKey = () => `codingProblem_${PSPPID}`

// ---------------------------------------------------------------- http

function toast(msg, ms = 2200) {
  const t = $("toast")
  t.textContent = msg
  t.hidden = false
  clearTimeout(t._h)
  t._h = setTimeout(() => { t.hidden = true }, ms)
}

let modalCompilerOutput = null

function dismissCompilerOutput() {
  rememberCompilerOutputPosition()
  $("compiler-output-float").hidden = true
  $("compiler-output-log").textContent = ""
}

function modal(title, html, { compilerOutput = null } = {}) {
  modalCompilerOutput = compilerOutput
  if (compilerOutput !== null) dismissCompilerOutput()
  $("modal-title").textContent = title
  $("modal-body").innerHTML = html
  $("modal-body").scrollTop = 0
  $("modal").hidden = false
}

function closeModal() {
  const output = modalCompilerOutput
  modalCompilerOutput = null
  $("modal").hidden = true
  if (output) {
    const log = $("compiler-output-log")
    log.textContent = output
    log.scrollTop = 0
    log.hidden = false
    $("btn-toggle-compiler-output").textContent = "收起"
    $("btn-toggle-compiler-output").setAttribute("aria-expanded", "true")
    $("compiler-output-float").hidden = false
    if (compilerPosition) moveCompilerOutput(compilerPosition.left, compilerPosition.top)
    else fitCompilerOutput()
  }
  if (output !== null && state.view) focusEditor(state.view)
}

$("btn-dismiss-compiler-output").onclick = () => {
  dismissCompilerOutput()
  if (state.view) focusEditor(state.view)
}
$("btn-toggle-compiler-output").onclick = event => {
  const log = $("compiler-output-log")
  log.hidden = !log.hidden
  event.currentTarget.textContent = log.hidden ? "展开" : "收起"
  event.currentTarget.setAttribute("aria-expanded", String(!log.hidden))
  fitCompilerOutput()
}

const compilerFloat = $("compiler-output-float")
const compilerHandle = $("compiler-output-handle")
let compilerDrag = null
let compilerPosition = null
const compilerPositionKey = `ptaCompilerOutputPosition_${PSID}`
try {
  const position = JSON.parse(localStorage.getItem(compilerPositionKey))
  if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) compilerPosition = position
} catch {}

function rememberCompilerOutputPosition() {
  if (compilerFloat.hidden) return
  const { left, top } = compilerFloat.getBoundingClientRect()
  compilerPosition = { left, top }
  try { localStorage.setItem(compilerPositionKey, JSON.stringify(compilerPosition)) } catch {}
}

function moveCompilerOutput(left, top) {
  const padding = 8
  const maxLeft = Math.max(padding, window.innerWidth - compilerFloat.offsetWidth - padding)
  const maxTop = Math.max(padding, window.innerHeight - compilerFloat.offsetHeight - padding)
  compilerFloat.style.left = Math.max(padding, Math.min(left, maxLeft)) + "px"
  compilerFloat.style.top = Math.max(padding, Math.min(top, maxTop)) + "px"
  compilerFloat.style.bottom = "auto"
}

function fitCompilerOutput() {
  if (compilerFloat.hidden || !compilerFloat.style.top) return
  const rect = compilerFloat.getBoundingClientRect()
  moveCompilerOutput(rect.left, rect.top)
}

compilerHandle.addEventListener("pointerdown", event => {
  if (event.button !== 0 || compilerDrag || event.target.closest("button")) return
  const rect = compilerFloat.getBoundingClientRect()
  compilerDrag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top }
  compilerHandle.setPointerCapture(event.pointerId)
  compilerHandle.classList.add("dragging")
  event.preventDefault()
})
compilerHandle.addEventListener("pointermove", event => {
  if (compilerDrag?.id !== event.pointerId) return
  moveCompilerOutput(event.clientX - compilerDrag.x, event.clientY - compilerDrag.y)
})
compilerHandle.addEventListener("lostpointercapture", event => {
  if (compilerDrag?.id !== event.pointerId) return
  compilerDrag = null
  compilerHandle.classList.remove("dragging")
  rememberCompilerOutputPosition()
})
window.addEventListener("resize", fitCompilerOutput)

$("modal-close").onclick = closeModal
$("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal() })
$("modal").addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("modal").hidden) closeModal()
})

// ---------------------------------------------------------------- 渲染
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

function renderQuestionBlocks(blocks) {
  return blocks.map(block => {
    if (block.kind === "code") return `<pre class="question-code">${escapeHtml(block.text)}</pre>`
    if (block.kind === "heading") return `<h3>${escapeHtml(block.text)}</h3>`
    if (block.kind === "image" && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(block.src)) {
      return `<img class="question-image" src="${block.src}" alt="${escapeHtml(block.alt || "题面配图")}">`
    }
    return block.kind === "text" ? `<p class="question-text">${escapeHtml(block.text)}</p>` : ""
  }).join("")
}

function renderProblem(psp) {
  const labelEl = $("problem-label")
  if (labelEl) {
    labelEl.textContent = psp.label || ""
    labelEl.hidden = !psp.label
  }
  $("problem-title").textContent = psp.title
  const raw = psp.content || psp.description || ""
  const parts = raw.split(/###\s*输入样例[：:]\s*/)
  const head = parts[0] || ""
  const rest = parts[1] || ""
  const cfg = psp.problemConfig.programmingProblemConfig
  let samplesHtml = ""
  if (rest) {
    const [inputPart, outputPartRaw] = rest.split(/###\s*输出样例[：:]\s*/)
    const outputPart = outputPartRaw || ""
    samplesHtml = `
      <h3 style="font-size:14px;margin:1.25rem 0 .5rem">输入样例</h3>
      <pre>${escapeHtml(inputPart.trim())}</pre>
      <h3 style="font-size:14px;margin:1.25rem 0 .5rem">输出样例</h3>
      <pre>${escapeHtml(outputPart.trim())}</pre>`
  } else {
    samplesHtml = (cfg.exampleTestDatas || []).map(({ input, output }, i) => `
      <h3>输入样例 ${i + 1}</h3><pre>${escapeHtml(input)}</pre>
      <h3>输出样例 ${i + 1}</h3><pre>${escapeHtml(output)}</pre>`).join("")
  }
  $("problem-body").innerHTML = `
    <h2>${escapeHtml(psp.title)}</h2>
    ${psp.chapter ? `<p class="problem-chapter-tag">${escapeHtml(psp.chapter)}</p>` : ""}
    ${psp.blocks?.length ? renderQuestionBlocks(psp.blocks) : `<div style="white-space:pre-wrap">${escapeHtml(head.trim())}</div>${samplesHtml}`}
    ${renderPracticeHints(psp.hints)}
    <div class="metas">
      ${psp.score != null ? `<div><b>分数</b>${psp.score}</div>` : ""}
      ${psp.author ? `<div><b>作者</b>${escapeHtml(psp.author)}</div>` : ""}
      <div><b>代码长度限制</b>${cfg.codeSizeLimit} KB</div>
      <div><b>时间限制</b>${cfg.timeLimit} ms</div>
      <div><b>内存限制</b>${Math.round(cfg.memoryLimit / 1024)} MB</div>
      <div><b>栈限制</b>${cfg.stackSizeLimit} KB</div>
    </div>`
}

function renderPracticeHints(hints) {
  if (!hints?.length) return ""
  const [idea, check] = hints
  return `<details class="program-hints">
    <summary>解题提示</summary>
    <p>${escapeHtml(idea)}</p>
    ${check ? `<details><summary>边界与易错点</summary><p>${escapeHtml(check)}</p></details>` : ""}
  </details>`
}

function renderCompilers(list) {
  const allowed = list.filter(c => COMPILER_META[c])
  if (!allowed.includes(state.compiler)) state.compiler = allowed[0] || "JAVAC"
  $("compiler-menu").innerHTML = allowed.map(c => {
    const m = COMPILER_META[c]
    return `<div data-c="${c}" class="${c === state.compiler ? "sel" : ""}">${m.language} (${m.displayName})</div>`
  }).join("")
  const m = COMPILER_META[state.compiler]
  $("compiler-label").textContent = `${m.language} (${m.displayName})`
}

// ---------------------------------------------------------------- 编辑器
function initEditor(docText) {
  const s = state.editorSettings
  state.view = createEditor({
    parent: $("editor"),
    doc: docText,
    compiler: state.compiler,
    fontSize: s.fontSize,
    tabSize: s.tabSize,
    onChange: () => { scheduleSave(); cacheLocal() },
  })
  focusEditor(state.view)
}

function cacheLocal() {
  if (!state.view) return
  const payload = { program: getText(state.view), compiler: state.compiler,
                    testData: state.testData, saveAt: new Date().toISOString(),
                    customExpected: $("test-check-output").checked, expectedOutput: $("test-expected-output").value }
  try { localStorage.setItem(cacheKey(), JSON.stringify(payload)) } catch {}
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(cacheKey()) || "null") } catch { return null }
}

// ---------------------------------------------------------------- 草稿
function buildDetail(withTestData) {
  const d = {
    problemId: "0",
    problemSetProblemId: PSPPID,
    programmingSubmissionDetail: {
      program: getText(state.view),
      compiler: state.compiler,
    },
  }
  if (withTestData) {
    d.customTestData = { hasCustomTestData: true, content: state.testData }
  }
  return d
}

function scheduleSave() {
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(() => saveDraft(), 3000)   // 线上是 debounce 3000ms
}

async function saveDraft() {
  if (!state.view || state.saving) return
  state.saving = true
  $("btn-save-draft").classList.add("loading")
  try {
    const detail = buildDetail(true)
    if (state.lastDetail && JSON.stringify(detail) === JSON.stringify(state.lastDetail)) return
    await api("POST", `/api/problem-sets/problems/${PSPPID}/exam-draft`,
      { answer: { detail, saveAt: new Date().toISOString() } })
    state.lastDetail = detail
  } catch (e) {
    toast("草稿保存失败：" + e.message)
  } finally {
    state.saving = false
    $("btn-save-draft").classList.remove("loading")
  }
}

// ---------------------------------------------------------------- 轮询
function pollSubmission(sid, onUpdate) {
  clearInterval(state.pollTimer)
  let tries = 0
  return new Promise((resolve, reject) => {
    const tick = async () => {
      tries += 1
      try {
        const data = await api("GET",
          `/api/exams/${EID}/submissions/${sid}?custom_test_data_submission=true`)
        const sub = data.submission
        onUpdate && onUpdate(sub)
        if (!PENDING.has(sub.status) || tries > 40) {
          clearInterval(state.pollTimer)
          resolve(sub)
        }
      } catch (e) {
        clearInterval(state.pollTimer)
        reject(e)
      }
    }
    tick()
    state.pollTimer = setInterval(tick, 3000)   // 线上考试作答面板 3000ms
  })
}

// ---------------------------------------------------------------- 自测
function exampleCases() {
  const cfg = state.psp.problemConfig.programmingProblemConfig
  return cfg.exampleTestDatas || []
}

function normalize(s) {
  return String(s || "").replace(/\r\n/g, "\n").split("\n").map(l => l.replace(/\s+$/, "")).join("\n").trim()
}

function matchingSample(input) {
  const normalizeNewlines = text => text.replace(/\r\n/g, "\n")
  const samples = exampleCases()
  const selected = Number($("test-sample").value || 0)
  const matches = ({ input: sampleInput }) => normalizeNewlines(sampleInput) === normalizeNewlines(input)
  return samples[selected] && matches(samples[selected]) ? selected : samples.findIndex(matches)
}

function sampleCase(sample, index) {
  return { input: sample.input, expected: sample.output, index, name: "公开样例 " + (index + 1), public: true }
}

function currentTestCase() {
  if ($("test-check-output").checked) {
    return { input: state.testData, expected: $("test-expected-output").value, name: "自定义比较" }
  }
  const index = matchingSample(state.testData)
  if (index >= 0) return sampleCase(exampleCases()[index], index)
  return { input: state.testData, expected: null, name: "自定义输入" }
}

function setTestPanelOpen(open) {
  $("test-panel").hidden = !open
  $("btn-toggle-test").classList.toggle("on", open)
}

function updateRunTestLabel() {
  const button = $("btn-run-test")
  if (button.disabled) return
  button.textContent = currentTestCase().public ? "▶ 运行示例" : "▶ 运行测试"
}

async function judgePracticeCase(test, detail) {
  const payload = { ...detail, customTestData: { ...detail.customTestData, content: test.input } }
  const { submissionId } = await api("POST", "/api/exams/" + EID + "/exam-submissions",
    { problemType: "PROGRAMMING", details: [payload] })
  const sub = await pollSubmission(submissionId)
  const judge = sub?.judgeResponseContents?.[0]?.programmingJudgeResponseContent
  const compilation = judge?.compilationResult
  if (sub?.status === "COMPILE_ERROR" || compilation?.success === false) {
    return { ...test, status: "COMPILE_ERROR", log: compilation?.log || compilation?.error || "" }
  }
  const run = judge?.testcaseJudgeResults?.custom
  if (!run) throw new Error("未收到运行结果，请重试")
  let status = "NEUTRAL"
  if (run.exceed && run.exceed !== "UNKNOWN_TESTCASE_EXCEED") status = run.exceed
  else if (run.exitcode !== 0) status = "RUNTIME_ERROR"
  else if (test.expected !== null) {
    const matched = normalize(run.stdout) === normalize(test.expected)
    status = test.public
      ? matched ? "SAMPLE_PASSED" : "SAMPLE_FAILED"
      : matched ? "CUSTOM_PASSED" : "SAMPLE_FAILED"
  }
  return { ...test, status, run, log: compilation?.log || "" }
}

function practiceCaseBadge(status) {
  const labels = { CUSTOM_PASSED: "与预期一致", NOT_RUN: "未运行", SERVICE_ERROR: "服务异常" }
  const kind = ["NEUTRAL", "SAMPLE_PASSED", "CUSTOM_PASSED"].includes(status) ? "pass"
    : status === "NOT_RUN" ? "wait" : "fail"
  return '<span class="status-pill ' + kind + '">' + escapeHtml(labels[status] || JUDGE_STATUS[status] || status) + '</span>'
}

function renderPracticeCase(test) {
  if (test.error) return '<p class="judge-empty">' + escapeHtml(test.error) + '</p>'
  if (!test.run) return ""
  const output = (title, value) => '<div><h4>' + title + '</h4><pre>' + escapeHtml(value) + '</pre></div>'
  return '<div class="practice-case-output"><div class="judge-input">' +
      output("本次输入", test.input || "（无输入）") + '</div>' +
    '<div class="judge-output' + (test.expected === null ? ' judge-output-single' : '') + '">' +
      output("实际输出", test.run.stdout || "（无输出）") +
      (test.expected === null ? "" : output("预期输出", test.expected || "（空输出）")) +
      (test.run.stderr ? '<div class="judge-output-stderr">' + output("错误输出", test.run.stderr) + '</div>' : "") +
    '</div></div>'
}

function showPracticeResults(results, batch) {
  const passed = results.filter(test => test.status === "SAMPLE_PASSED").length
  const log = results.find(test => test.status === "COMPILE_ERROR")?.log || results.find(test => test.log)?.log || ""
  const first = results[0]
  const summary = batch ? "公开样例通过 " + passed + " / " + results.length : ""
  const resultBadge = batch
    ? '<span class="status-pill ' + (passed === results.length ? "pass" : "fail") + '">' + summary + '</span>'
    : practiceCaseBadge(first.status)
  const elapsed = judgeMillis(first.run?.time)
  $("test-metrics").innerHTML = resultBadge + (!batch && elapsed != null ? '<span>用时 ' + elapsed + ' ms</span>' : "") +
    (!batch && first.run?.exitcode != null ? '<span>退出码 ' + escapeHtml(first.run.exitcode) + '</span>' : "")
  $("test-result").className = "result-grid one"
  $("test-result").innerHTML = batch
    ? '<div class="result-box">' + results.map(test => '<p>' + escapeHtml(test.name) + ' ' + practiceCaseBadge(test.status) + '</p>').join("") + '</div>'
    : renderPracticeCase(first) || (log ? '<div class="result-box"><h4>编译日志</h4><pre>' + escapeHtml(log) + '</pre></div>' : "")

  const cases = results.map(test => {
    const elapsed = judgeMillis(test.run?.time)
    const header = escapeHtml(test.name) + ' ' + practiceCaseBadge(test.status) +
      (elapsed != null ? '<span>用时 ' + elapsed + ' ms</span>' : "")
    return '<section class="judge-block"><h3 class="practice-case-head">' + header + '</h3>' + renderPracticeCase(test) + '</section>'
  }).join("")
  const title = batch ? "全部公开样例" : first.public ? "样例评测结果" : "运行测试结果"
  modal(title, '<div class="judge-result">' + (summary ? '<p class="practice-case-summary">' + summary + '</p>' : "") + cases +
    '<section class="judge-block"><h3>编译器输出</h3>' +
    (log ? '<pre class="judge-compiler-log">' + escapeHtml(log) + '</pre>' : '<p class="judge-empty">无编译器输出</p>') +
    '</section></div>', { compilerOutput: log })
  $("modal-close").focus()
}

async function runTest(batch = false) {
  const singleButton = $("btn-run-test")
  const batchButton = $("btn-run-all-tests")
  if (singleButton.disabled) return
  // Snapshot the program, input and expected output before the first request.
  const detail = buildDetail(true)
  const tests = batch ? exampleCases().map(sampleCase) : [currentTestCase()]
  if (!tests.length) return
  if (!detail.programmingSubmissionDetail.program.trim()) {
    toast("请先输入 Java 代码")
    focusEditor(state.view)
    return
  }
  const activeButton = batch ? batchButton : singleButton
  const buttonLabel = activeButton.textContent
  singleButton.disabled = batchButton.disabled = true
  activeButton.textContent = "运行中…"
  setTestPanelOpen(true)
  $("test-result").textContent = ""
  try {
    const results = []
    let stop = false
    for (const test of tests) {
      if (stop) {
        results.push({ ...test, status: "NOT_RUN" })
        continue
      }
      $("test-metrics").textContent = batch ? "正在运行 " + (results.length + 1) + " / " + tests.length : "评测中…"
      try {
        const result = await judgePracticeCase(test, detail)
        results.push(result)
        stop = result.status === "COMPILE_ERROR"
      } catch (error) {
        results.push({ ...test, status: "SERVICE_ERROR", error: error.message })
        stop = true
      }
    }
    if (!batch && results[0].status === "SERVICE_ERROR") {
      $("test-metrics").textContent = "运行失败：" + results[0].error
      return
    }
    showPracticeResults(results, batch)
    const judgedSamples = results.filter(test => test.public && test.run)
    if (state.psp.sampleOnly && judgedSamples.length) {
      const sampleResults = { ...practiceAnswers[PSPPID]?.sampleResults }
      for (const test of judgedSamples) {
        sampleResults[test.index] = test.status === "SAMPLE_PASSED"
      }
      const sampleWrong = Object.values(sampleResults).includes(false)
      practiceAnswers[PSPPID] = { sampleRun: true, sampleWrong, sampleResults }
      savePracticeAnswers()
      loadProgramPracticeStatus()
    }
    saveDraft()
  } finally {
    singleButton.disabled = batchButton.disabled = false
    activeButton.textContent = buttonLabel
    updateRunTestLabel()
  }
}


// ---------------------------------------------------------------- 正式提交
async function submit() {
  const btn = $("btn-submit")
  if (btn.disabled) return
  btn.disabled = true
  btn.textContent = "提交中…"
  try {
    const { submissionId } = await api("POST", `/api/exams/${EID}/submissions`,
      { problemType: "PROGRAMMING", details: [buildDetail(false)] })   // 不带 customTestData
    toast("已提交，评测中…")
    const sub = await pollSubmission(submissionId)
    localStorage.removeItem(cacheKey())
    showSubmissionResult(sub)
    if (sub && !PENDING.has(sub.status)) loadProgramPracticeStatus()
    saveDraft()
  } catch (e) {
    toast("提交失败：" + e.message)
  } finally {
    btn.disabled = false
    btn.textContent = "提交本题作答"
  }
}

function statusClass(s) {
  if (s === "ACCEPTED") return "pass"
  if (PENDING.has(s)) return "wait"
  return "fail"
}

const JUDGE_STATUS = {
  ACCEPTED: "答案正确", WRONG_ANSWER: "答案错误", PARTIAL_ACCEPTED: "部分正确",
  COMPILE_ERROR: "编译错误", RUNTIME_ERROR: "运行错误", TIME_LIMIT_EXCEEDED: "运行超时",
  MEMORY_LIMIT_EXCEEDED: "内存超限", OUTPUT_LIMIT_EXCEEDED: "输出超限",
  WAITING: "等待评测", JUDGING: "评测中", REJUDGING: "重新评测中",
  NEUTRAL: "运行结束", SAMPLE_PASSED: "样例通过", SAMPLE_FAILED: "与预期不一致",
}

const judgeMillis = seconds => typeof seconds === "number" ? Math.round(seconds * 1000) : null
const judgeMemory = bytes => bytes > 0 ? Math.round(bytes / 1024) : null
const judgeScore = (score, max) => max == null ? score ?? "—" : `${score ?? 0} / ${max}`

function showSubmissionResult(sub, { problem = state.psp } = {}) {
  if (!sub) return
  const cfg = problem?.problemConfig?.programmingProblemConfig || {}
  const judged = sub.judgeResponseContents?.[0]?.programmingJudgeResponseContent || {}
  const compilation = judged.compilationResult || {}
  const cases = Object.entries(judged.testcaseJudgeResults || {})
  const displayStatus = value => JUDGE_STATUS[value] || value || "—"
  const badge = value => {
    const kind = value === "SAMPLE_PASSED" || value === "NEUTRAL" ? "pass" : statusClass(value)
    return `<span class="status-pill ${kind}" title="${escapeHtml(value || "")}">${escapeHtml(displayStatus(value))}</span>`
  }
  const rows = cases.map(([name, test]) => {
    const testConfig = cfg.cases?.[name]
    const hints = testConfig?.showHint ? testConfig.hint : ""
    return `<tr>
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(hints || "—")}</td>
      <td>${judgeMemory(test.memory) ?? "—"}</td>
      <td>${judgeMillis(test.time) ?? "—"}</td>
      <td>${badge(test.result)}</td>
      <td>${escapeHtml(judgeScore(test.testcaseScore, testConfig?.score))}</td>
    </tr>`
  }).join("")
  const codeOutput = String(compilation.log || compilation.error || "").replace(/\r\n/g, "\n")
  modal("提交结果", `<div class="judge-result">
    <section class="judge-block"><h3>评测详情</h3>
      ${rows ? `<table class="judge-table">
        <thead><tr><th>测试点</th><th>提示</th><th>内存 (KB)</th><th>用时 (ms)</th><th>结果</th><th>得分</th></tr></thead>
        <tbody>${rows}</tbody></table>` : `<p class="judge-empty">${badge(sub.status)}　暂无测试点结果</p>`}
    </section>
    <section class="judge-block"><h3>编译器输出</h3>
      ${codeOutput ? `<pre class="judge-compiler-log">${escapeHtml(codeOutput)}</pre>` : '<p class="judge-empty">无编译器输出</p>'}
    </section></div>`, { compilerOutput: codeOutput })
  $("modal-close").focus()
}

async function showLastSubmission() {
  try {
    const data = await api("GET",
      `/api/exams/${EID}/problem-sets/${PSID}/last-submissions?problem_set_problem_id=${PSPPID}`)
    const sub = data.submission
    if (!sub) { modal("上次提交", "<p>还没有提交记录。</p>"); return }
    if (!sub.submissionDetails?.[0]?.customTestData?.hasCustomTestData) {
      showSubmissionResult(sub)
      return
    }
    const d = (sub.submissionDetails || [])[0] || {}
    const code = (d.programmingSubmissionDetail || {}).program || ""
    const test = (d.customTestData || {}).content || ""
    modal("上次提交", `
      <p>提交号 ${sub.id}　状态 <span class="status-pill ${statusClass(sub.status)}">${sub.status}</span>
         编译器 ${sub.compiler}　时间 ${sub.submitAt}</p>
      <h4>自测测试用例</h4><pre>${escapeHtml(test) || "（无）"}</pre>
      <h4>程序代码</h4><pre>${escapeHtml(code)}</pre>`)
  } catch (e) {
    toast("读取失败：" + e.message)
  }
}

// ---------------------------------------------------------------- 设置
const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20]

function openSettings() {
  const s = state.editorSettings
  modal("编辑器设置", `
    <p>字号
      <select id="set-font">${FONT_SIZES.map(n =>
        `<option value="${n}" ${n === s.fontSize ? "selected" : ""}>${n}</option>`).join("")}</select>
    </p>
    <p>缩进
      <select id="set-tab">${[2, 4, 8].map(n =>
        `<option value="${n}" ${n === s.tabSize ? "selected" : ""}>${n}</option>`).join("")}</select>
    </p>
    <p><button class="btn primary" id="set-ok">保存</button></p>`)
  $("set-ok").onclick = async () => {
    s.fontSize = Number($("set-font").value)
    s.tabSize = Number($("set-tab").value)
    setFontSize(state.view, s.fontSize)
    setTabSize(state.view, s.tabSize)
    try {
      await api("POST", "/api/user-storage/names/editorSettings",
        { name: "editorSettings", value: JSON.stringify(s) })
      toast("设置已保存")
    } catch (e) { toast("保存失败：" + e.message) }
    $("modal").hidden = true
  }
}

function openCompilerInfo() {
  const m = COMPILER_META[state.compiler]
  modal("编译器", `
    <p><b>${m.language} (${m.displayName} ${m.version})</b></p>
    <p>编译命令：<code>${escapeHtml(m.compileCmd || "（解释执行，无编译步骤）")}</code></p>
    <p>运行命令：<code>${escapeHtml(m.runCmd)}</code></p>
    <p style="color:var(--text-light)">时间限制 ${state.psp.problemConfig.programmingProblemConfig.timeLimit} ms，
       内存限制 ${state.psp.problemConfig.programmingProblemConfig.memoryLimit} MB，
       代码长度限制 ${state.psp.problemConfig.programmingProblemConfig.codeSizeLimit} KB。</p>`)
}

// ---------------------------------------------------------------- 布局
function initSplit() {
  const split = $("split")
  const sep = $("separator")
  let dragging = false
  sep.addEventListener("mousedown", e => { dragging = true; e.preventDefault(); document.body.style.userSelect = "none" })
  window.addEventListener("mouseup", () => { dragging = false; document.body.style.userSelect = "" })
  window.addEventListener("mousemove", e => {
    if (!dragging) return
    const rect = split.getBoundingClientRect()
    if (split.classList.contains("vertical")) {
      const h = Math.min(Math.max(e.clientY - rect.top, 120), rect.height - 160)
      split.querySelector(".problem-pane").style.flex = `0 0 ${h}px`
    } else {
      const w = Math.min(Math.max(e.clientX - rect.left, 240), rect.width - 320)
      split.querySelector(".problem-pane").style.flex = `0 0 ${w}px`
    }
  })
  $("btn-layout").onclick = () => {
    split.classList.toggle("vertical")
    sep.setAttribute("aria-orientation", split.classList.contains("vertical") ? "horizontal" : "vertical")
    split.querySelector(".problem-pane").style.flex = ""
  }
  $("btn-fullscreen").onclick = () => {
    split.classList.toggle("fullscreen")
    $("btn-fullscreen").textContent = split.classList.contains("fullscreen") ? "退出全屏" : "全屏浏览"
  }
}

// ---------------------------------------------------------------- 启动
async function boot() {
  $("answer-view").hidden = false
  $("exam-app").classList.add("program-practice")
  $("nav-home").classList.add("active")
  try {
    const [exams, problem, storage] = await Promise.all([
      api("GET", `/api/problem-sets/${PSID}/exams`),
      api("GET", `/api/problem-sets/${PSID}/exam-problems/${PSPPID}`),
      api("GET", "/api/user-storage/names/editorSettings"),
    ])
    state.config = exams.problemSet.problemSetConfig || {}
    state.psp = { ...problem.problemSetProblem, label: problem.examLabel || problem.problemSetProblem.label }
    $("ps-name").textContent = exams.problemSet.name
    document.title = `${problem.problemSetProblem.title} - ${exams.problemSet.name}`

    const items = (storage.items || [])
    if (items[0] && items[0].value) {
      try { Object.assign(state.editorSettings, JSON.parse(items[0].value)) } catch {}
    }

    renderProblem(state.psp)
    const back = $("back-to-filter")
    if (practiceScope === "browse") {
      back.href = homeUrl(practiceFilters)
      back.hidden = false
    }
    $("btn-submit").hidden = !!state.psp.sampleOnly
    $("btn-last").hidden = !!state.psp.sampleOnly
    $("sample-only-note").hidden = !state.psp.sampleOnly
    for (const [buttonId, problemId] of [
      ["btn-prev-problem", problem.previousProblemId], ["btn-next-problem", problem.nextProblemId],
    ]) {
      if (problemId) {
        $(buttonId).disabled = false
        $(buttonId).onclick = () => { location.href = problemUrl(problemId) }
      }
    }
    renderCompilers(state.config.compilers || ["JAVAC"])

    // 草稿：localStorage 与服务端取 saveAt 较新的一份（与线上同策略）
    const cached = readCache()
    let draftDetail = null, draftAt = 0
    try {
      const draft = await api("GET", `/api/problem-sets/problems/${PSPPID}/exam-draft`)
      if (draft.answer && draft.answer.detail) {
        draftDetail = draft.answer.detail
        draftAt = new Date(draft.answer.saveAt || 0).getTime()
      }
    } catch {}
    const useCache = cached && new Date(cached.saveAt || 0).getTime() > draftAt
    const draftProgram = draftDetail?.programmingSubmissionDetail
    const savedCompiler = (useCache ? cached.compiler : null) || draftProgram?.compiler
    if (COMPILER_META[savedCompiler]) {
      state.compiler = savedCompiler
      renderCompilers(state.config.compilers || ["JAVAC"])
    }
    const savedProgram = (useCache ? cached.program : null) ?? draftProgram?.program ?? ""
    const docText = savedProgram.replace(/\r\n/g, "\n").trimEnd() === LEGACY_JAVA_STARTER ? "" : savedProgram
    state.testData = (useCache ? cached.testData : null)
      ?? draftDetail?.customTestData?.content
      ?? exampleCases()[0]?.input
      ?? ""

    initEditor(docText)
    loadProgramPracticeStatus()
    $("test-input").value = state.testData
    const samples = exampleCases()
    $("test-check-output").checked = cached?.customExpected === true
    $("test-expected-output").value = cached?.expectedOutput ?? ""
    $("test-expected-field").hidden = !$("test-check-output").checked
    $("btn-run-all-tests").hidden = samples.length < 2
    const samplePicker = $("test-sample-picker")
    if (samples.length > 1) {
      samplePicker.hidden = false
      const select = $("test-sample")
      select.innerHTML = samples.map((_, index) => `<option value="${index}">样例 ${index + 1}</option>`).join("")
      select.onchange = () => $("btn-reset-test").click()
    }
    updateRunTestLabel()
    initSplit()

    // 事件
    // 截图/联调用的深链：?panel  直接展开测试用例；?layout=vertical 上下分栏
    const qs = new URLSearchParams(location.search)
    if (qs.has("panel")) setTestPanelOpen(true)
    if (qs.get("layout") === "vertical") $("btn-layout").click()

    $("btn-toggle-test").onclick = () => setTestPanelOpen($("test-panel").hidden)
    $("test-input").addEventListener("input", e => {
      state.testData = e.target.value
      updateRunTestLabel()
      scheduleSave()
    })
    $("test-check-output").onchange = () => {
      $("test-expected-field").hidden = !$("test-check-output").checked
      updateRunTestLabel()
      cacheLocal()
    }
    $("test-expected-output").oninput = cacheLocal
    $("btn-reset-test").onclick = () => {
      const c = exampleCases()[Number($("test-sample").value || 0)]
      state.testData = c ? c.input : ""
      $("test-input").value = state.testData
      $("test-check-output").checked = false
      $("test-expected-field").hidden = true
      updateRunTestLabel()
      cacheLocal()
      scheduleSave()
    }
    $("btn-run-test").onclick = () => runTest()
    $("btn-run-all-tests").onclick = () => runTest(true)
    $("btn-submit").onclick = submit
    $("btn-last").onclick = showLastSubmission
    $("btn-save-draft").onclick = () => saveDraft().then(() => toast("草稿已保存"))
    $("btn-settings").onclick = openSettings
    $("btn-compiler-info").onclick = openCompilerInfo
    $("btn-editor-fullscreen").onclick = () => {
      $("answer-pane").scrollIntoView({ block: "nearest" })
      $("split").classList.toggle("fullscreen")
    }

    // 编译器切换
    $("compiler-btn").onclick = e => {
      e.stopPropagation()
      $("compiler-select").classList.toggle("open")
    }
    $("compiler-menu").addEventListener("click", e => {
      const c = e.target.dataset.c
      if (!c) return
      state.compiler = c
      setLanguage(state.view, c)
      renderCompilers(state.config.compilers || ["JAVAC"])
      $("compiler-select").classList.remove("open")
      scheduleSave()
    })
    document.addEventListener("click", () => $("compiler-select").classList.remove("open"))

    window.addEventListener("beforeunload", () => { cacheLocal() })
    // 切题/卸载时强制落地一次（线上 componentWillUnmount 同样会 handleSave(true)）
    document.addEventListener("visibilitychange", () => { if (document.hidden) saveDraft() })
  } catch (e) {
    if (e.status === 404) {
      if (!requestedProblemId) {
        location.replace(pageUrl("problems"))
        return
      }
      $("problem-body").innerHTML = `<p>题目不存在或已删除。</p>
        <p><a href="${pageUrl("problems")}">返回题目列表</a></p>`
      return
    }
    $("problem-body").innerHTML =
      `<p style="color:var(--danger)">加载失败：${escapeHtml(e.message)}</p>
       <p style="color:var(--text-light)">确认 <code>python mock/server.py</code> 已启动，且页面是通过
       <code>http://127.0.0.1:8765/</code> 打开的（不要直接双击 index.html）。</p>`
  }
}

const pageUrl = page => `/?page=${page}`
const problemUrl = (id, type = "PROGRAMMING", scope = "", filters = {}) => {
  const query = new URLSearchParams({ problemSetProblemId: id })
  if (scope) query.set("scope", scope)
  if (scope === "browse") appendFilters(query, filters)
  return `${pageUrl(type === "PROGRAMMING" ? "programming" : "review")}&${query}`
}
const submissionsPath = `/api/exams/${EID}/problem-sets/${PSID}/submissions`
const submissionPageSize = 10

const PRACTICE_TYPES = {
  TRUE_FALSE: "判断题", SINGLE_CHOICE: "单选题", MULTIPLE_CHOICE: "多选题",
  PROGRAM_FILL_IN: "程序填空题", PROGRAMMING: "编程题", IMPORTED_REVIEW: "其他题目",
}
const practiceQuery = new URLSearchParams(location.search)
const practiceScope = practiceQuery.get("scope") || ""
const practiceFilters = {
  q: practiceQuery.get("q") || "",
  chapter: practiceQuery.get("chapter") || "",
  status: practiceQuery.get("status") || "",
}
const chapterName = problem => problem.chapter || "未分类"
const searchKey = value => value.normalize("NFKC").toLowerCase()

function appendFilters(query, { q, chapter, status }) {
  if (q?.trim()) query.set("q", q.trim())
  if (chapter) query.set("chapter", chapter)
  if (["new", "wrong"].includes(status)) query.set("status", status)
}

function homeUrl(filters) {
  const query = new URLSearchParams()
  appendFilters(query, filters)
  return query.size ? "/?" + query : "/"
}

function filterProblems(problems, { q, chapter, status }, currentId = "") {
  const terms = searchKey(q).trim().split(/\s+/).filter(Boolean)
  return problems.filter(problem => {
    if (problem.id === currentId) return true
    if (chapter && chapter !== chapterName(problem)) return false
    if (status === "new" && hasPracticeAnswer(problem)) return false
    if (status === "wrong" && practiceOutcome(problem) !== "wrong") return false
    if (!terms.length) return true
    const label = [problem.label, problem.title, problem.searchable].join(" ")
    const text = searchKey(label)
    return terms.every(term => text.includes(term))
  })
}
const practiceKey = `ptaPracticeAnswers_${PSID}`
let practiceAnswers = {}
try {
  const stored = JSON.parse(localStorage.getItem(practiceKey))
  if (stored && typeof stored === "object" && !Array.isArray(stored)) practiceAnswers = stored
} catch {}
function savePracticeAnswers() {
  try { localStorage.setItem(practiceKey, JSON.stringify(practiceAnswers)) } catch {}
}
const getPracticeProblems = async () => {
  const { problems } = await api("GET", `/api/problem-sets/${PSID}/exam-problem-list?exam_id=${EID}`)
  return problems
}
const practiceOutcome = problem => {
  if (problem.type === "PROGRAMMING") {
    if (problem.sampleOnly) return practiceAnswers[problem.id]?.sampleWrong ? "wrong" : ""
    if (!problem.status || PENDING.has(problem.status)) return ""
    return problem.status === "ACCEPTED" ? "correct" : "wrong"
  }
  const saved = practiceAnswers[problem.id]?.outcome
  return saved === "correct" || saved === "wrong" ? saved : ""
}
const practiceGroup = (problems, currentId = "") => {
  if (practiceScope === "browse") return filterProblems(problems, practiceFilters, currentId)
  if (practiceScope === "wrong") return problems.filter(p => p.id === currentId || practiceOutcome(p) === "wrong")
  if (Object.hasOwn(PRACTICE_TYPES, practiceScope)) return problems.filter(p => p.type === practiceScope || p.id === currentId)
  return problems
}
const practiceLink = (problem, scope = practiceScope, filters = practiceFilters) =>
  problemUrl(problem.id, problem.type, scope, filters)
const hasPracticeAnswer = problem => Boolean(practiceOutcome(problem) ||
  practiceAnswers[problem.id]?.answer || (problem.sampleOnly && practiceAnswers[problem.id]?.sampleRun))
const practiceProgress = problems => {
  const correct = problems.filter(p => practiceOutcome(p) === "correct").length
  const wrong = problems.filter(p => practiceOutcome(p) === "wrong").length
  const done = problems.filter(hasPracticeAnswer).length
  return { correct, wrong, done }
}
const percent = (n, total) => total ? Math.round(n / total * 100) : 0
const progressBar = (done, total) =>
  `<progress class="practice-progress" value="${done}" max="${total || 1}" aria-label="练习进度"></progress>`

function renderAnswerProgress(container, problems, index) {
  if (!container || index < 0) return
  const completed = problems.filter(hasPracticeAnswer).length
  const menuWasOpen = !!container.querySelector("details[open]")
  const scrollTop = container.querySelector(".answer-progress-links")?.scrollTop || 0
  const links = problems.map((problem, offset) => {
    const status = practiceOutcome(problem) === "wrong" ? "wrong"
      : hasPracticeAnswer(problem) ? "completed" : "incomplete"
    const statusText = { completed: "已完成", incomplete: "未完成", wrong: "回答错误" }[status]
    const label = `第 ${offset + 1} 题 · ${statusText} · ${problem.label} ${problem.title}`
    return `<a class="${status}" href="${practiceLink(problem)}" title="${escapeHtml(label)}"
      aria-label="${escapeHtml(label)}" ${index === offset ? 'aria-current="step"' : ""}>${offset + 1}</a>`
  }).join("")
  container.innerHTML = `<details class="answer-progress-menu" ${menuWasOpen ? "open" : ""}>
    <summary>答题进度</summary>
    <div class="answer-progress-grid">
      <div class="answer-progress-legend" aria-hidden="true">
        <span class="answer-progress-legend-item"><i class="current"></i>当前题</span>
        <span class="answer-progress-legend-item"><i class="completed"></i>已完成</span>
        <span class="answer-progress-legend-item"><i class="wrong"></i>错题</span>
        <span class="answer-progress-legend-item"><i></i>未作答</span>
      </div>
      <nav class="answer-progress-links" aria-label="题号导航">${links}</nav>
    </div>
  </details>
    <span>第 ${index + 1} / ${problems.length} 题</span>
    ${progressBar(completed, problems.length)}
    <span>已作答 ${completed} / ${problems.length}</span>`
  if (menuWasOpen) container.querySelector(".answer-progress-links").scrollTop = scrollTop
}

document.addEventListener("click", event => {
  const menu = document.querySelector(".answer-progress-menu[open]")
  if (menu && !menu.contains(event.target)) menu.open = false
})
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return
  const menu = document.querySelector(".answer-progress-menu[open]")
  if (menu && $("modal").hidden) {
    menu.open = false
    menu.querySelector("summary").focus()
  }
})

async function loadProgramPracticeStatus() {
  try {
    const problems = practiceGroup(await getPracticeProblems(), PSPPID)
    const index = problems.findIndex(p => p.id === PSPPID)
    if (index === -1) return
    renderAnswerProgress($("program-answer-progress"), problems, index)
    for (const [buttonId, item] of [
      ["btn-prev-problem", problems[index - 1]], ["btn-next-problem", problems[index + 1]],
    ]) {
      const button = $(buttonId)
      button.disabled = !item
      button.onclick = item ? () => { location.href = practiceLink(item) } : null
    }
  } catch {
    // 作答仍可使用题面接口提供的同题型导航。
  }
}

async function loadPracticeHome() {
  $("page-status").textContent = "正在加载题库…"
  try {
    const problems = await getPracticeProblems()
    const all = practiceProgress(problems)
    const remain = Math.max(0, problems.length - all.done)
    const accuracy = percent(all.correct, all.correct + all.wrong)
    const overallProgress = percent(all.done, problems.length)
    const chapterCount = new Set(problems.map(chapterName)).size
    const wrong = problems.filter(p => practiceOutcome(p) === "wrong")
    const nextTodo = problems.find(p => !hasPracticeAnswer(p)) || problems[0]
    const stats = [
      [all.done, "已作答", "total"],
      [all.correct, "答对", "correct"],
      [all.wrong, "答错", "wrong"],
      [`${accuracy}%`, "正确率", "rate"],
      [remain, "未作答", "remain"],
    ]
    const deck = (title, items, scope, action) => {
      const { done } = practiceProgress(items)
      const first = scope === "wrong" ? items[0] : items.find(p => !hasPracticeAnswer(p)) || items[0]
      const rate = percent(done, items.length)
      const wrongCard = scope === "wrong" && items.length ? " is-wrong" : ""
      return `<section class="practice-card practice-deck${wrongCard}">
        <div class="practice-deck-head">
          <h3>${title}</h3>
          <span class="practice-deck-rate">${scope === "wrong" ? `${items.length} 题` : `${rate}%`}</span>
        </div>
        <p>${items.length} 道题 · ${scope === "wrong" ? "待复习重做" : `已答 ${done}`}</p>
        ${progressBar(done, items.length)}
        <div class="practice-deck-foot">
          ${first ? `<a class="practice-action" href="${practiceLink(first, scope)}">${action} →</a>` : '<span class="practice-muted">暂无题目</span>'}
        </div>
      </section>`
    }
    const groups = Object.entries(PRACTICE_TYPES).map(([type, title]) => {
      const group = problems.filter(p => p.type === type)
      return group.length ? deck(title, group, type, "开始练习") : ""
    }).join("")
    $("page-status").textContent = ""
    $("page-body").innerHTML = `
      <section class="practice-card practice-hero">
        <div class="practice-hero-main">
          <h1>开始刷题</h1>
          <p class="practice-hero-meta">Java 题库共 ${problems.length} 道题 · ${chapterCount} 个章节 · 总完成度 <strong>${overallProgress}%</strong></p>
          <div class="practice-hero-progress">${progressBar(all.done, problems.length)}</div>
        </div>
        <div class="practice-hero-actions">
          ${nextTodo ? `<a class="btn primary" href="${practiceLink(nextTodo, "")}">${all.done ? "继续刷题" : "开始刷题"}</a>` : ""}
          ${wrong.length ? `<a class="btn soft-danger" href="${practiceLink(wrong[0], "wrong")}">重做错题 (${wrong.length})</a>` : ""}
        </div>
      </section>
      <section class="practice-stats" aria-label="练习统计">${stats.map(([value, label, color]) => `
        <div class="practice-card practice-stat ${color}"><strong>${value}</strong><span>${label}</span></div>`).join("")}</section>
      <section class="practice-card practice-browser" aria-labelledby="practice-browser-title">
        <div class="practice-browser-head">
          <h2 id="practice-browser-title">查找题目</h2>
        </div>
        <form id="practice-filters" class="practice-filters">
          <label>搜索<input name="q" type="search" placeholder="输入题号、标题或题干关键词"></label>
          <label>章节<select name="chapter"><option value="">全部章节</option>
            ${[...new Set(problems.map(chapterName))].map(chapter => `<option value="${escapeHtml(chapter)}">${escapeHtml(chapter)}</option>`).join("")}
          </select></label>
          <label>作答状态<select name="status"><option value="">全部状态</option><option value="new">未作答</option>
            <option value="wrong">错题</option></select></label>
          <button class="btn" type="reset">清除筛选</button>
        </form>
        <div class="practice-browser-actions"><p id="practice-find-count" role="status"></p>
          <a class="btn primary" id="practice-start-filter" hidden>练习筛选结果</a></div>
        <ul class="practice-found" id="practice-found"></ul>
        <button class="btn" id="practice-more" type="button" hidden>显示更多题目</button>
      </section>
      <h2 class="practice-section-title">全部题目</h2>
      <div class="practice-decks">
        ${deck("整套题库", problems, "", "开始 / 继续练习")}
        ${deck("错题集", wrong, "wrong", "重做错题")}
      </div>
      ${groups ? `<h2 class="practice-section-title">按题型练习</h2><div class="practice-decks practice-decks-types">${groups}</div>` : ""}`
    initPracticeBrowser(problems)
  } catch (e) {
    $("page-status").textContent = "读取题库失败：" + e.message
  }
}

function initPracticeBrowser(problems) {
  const form = $("practice-filters")
  const found = $("practice-found")
  const more = $("practice-more")
  const start = $("practice-start-filter")
  const pageSize = 8
  let shown = pageSize
  for (const [name, value] of Object.entries(practiceFilters)) {
    const control = form.elements.namedItem(name)
    if (name === "q" || [...control.options].some(option => option.value === value)) control.value = value
  }

  function refresh(reset = true) {
    if (reset) shown = pageSize
    const filters = Object.fromEntries(new FormData(form))
    const url = homeUrl(filters)
    if (url !== location.pathname + location.search) history.replaceState(null, "", url)
    const results = filterProblems(problems, filters)
    const first = results.find(problem => !hasPracticeAnswer(problem)) || results[0]
    $("practice-find-count").innerHTML = results.length ? `找到 <strong>${results.length}</strong> 道题` : "未找到符合条件的题目"
    start.hidden = !first
    if (first) start.href = practiceLink(first, "browse", filters)
    more.hidden = results.length <= shown
    found.innerHTML = results.slice(0, shown).map(problem => {
      const isWrong = practiceOutcome(problem) === "wrong"
      const isDone = !isWrong && hasPracticeAnswer(problem)
      const status = isWrong ? "错题" : isDone ? "已作答" : "未作答"
      const statusCls = isWrong ? "is-wrong" : isDone ? "is-done" : "is-new"
      return `<li><a href="${escapeHtml(practiceLink(problem, "browse", filters))}">
        <span class="practice-found-label">${escapeHtml(problem.label)}</span>
        <strong>${escapeHtml(problem.title)}</strong>
        <span class="practice-found-meta">
          <span class="practice-found-tag">${escapeHtml(chapterName(problem))}</span>
          <span class="practice-found-tag">${PRACTICE_TYPES[problem.type] || "题目"}</span>
          <span class="practice-status-badge ${statusCls}">${status}</span>
        </span>
      </a></li>`
    }).join("")
  }
  form.oninput = () => refresh()
  form.onsubmit = event => { event.preventDefault(); refresh() }
  form.onreset = () => queueMicrotask(() => refresh())
  more.onclick = () => { shown += pageSize; refresh(false) }
  refresh()
}

async function loadSubmissions(after = "", before = "") {
  $("page-body").inert = true
  $("page-status").textContent = "正在加载提交记录…"
  try {
    const query = new URLSearchParams({ limit: submissionPageSize + 1 })
    if (after) query.set("after", after)
    if (before) query.set("before", before)
    const { submissions, problemById } = await api("GET", `${submissionsPath}?${query}`)
    const extra = submissions.length > submissionPageSize
    const items = before ? submissions.slice(-submissionPageSize) : submissions.slice(0, submissionPageSize)
    if (!items.length) {
      $("page-status").textContent = ""
      $("page-body").innerHTML = `
        <section class="practice-card practice-empty-state">
          <span class="practice-empty-badge">公开刷题版</span>
          <h2>暂无正式提交记录</h2>
          <p>当前公开练习版专注章节刷题、错题复习与公开样例即时评测，不提供整卷交卷与历史判题流水。</p>
          <a class="btn primary" href="/">返回首页刷题</a>
        </section>`
      return
    }
    $("page-status").textContent = ""
    $("page-body").innerHTML = `
      <div class="exam-table-wrap">
        <table class="exam-table" aria-label="提交记录">
          <thead><tr><th>提交号</th><th>题目</th><th>状态</th><th>得分</th><th>编译器</th><th>提交时间</th><th>详情</th></tr></thead>
          <tbody>${items.map(sub => `<tr>
            <td>${escapeHtml(sub.id)}</td>
            <td>${escapeHtml(problemById?.[sub.submissionDetails?.[0]?.problemSetProblemId]?.label || "—")}</td>
            <td><span class="status-pill ${statusClass(sub.status)}">${escapeHtml(sub.status)}</span></td>
            <td>${escapeHtml(sub.score ?? 0)}</td>
            <td>${escapeHtml(sub.compiler || "—")}</td>
            <td>${escapeHtml(new Date(sub.submitAt).toLocaleString("zh-CN"))}</td>
            <td><button class="btn" data-submission-id="${escapeHtml(sub.id)}">查看详情</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="exam-pagination">
        <button class="btn" id="btn-submissions-prev" ${(before ? !extra : !after) ? "disabled" : ""}>上一页</button>
        <button class="btn" id="btn-submissions-next" ${!before && !extra ? "disabled" : ""}>下一页</button>
      </div>`
    if (!items.length) return
    $("btn-submissions-prev").onclick = () => loadSubmissions("", items[0].id)
    $("btn-submissions-next").onclick = () => loadSubmissions(items.at(-1).id)
  } catch (e) {
    $("page-status").textContent = "读取提交记录失败：" + e.message
  } finally {
    $("page-body").inert = false
  }
}

$("page-body").addEventListener("click", async e => {
  const btn = e.target.closest("[data-submission-id]")
  if (!btn) return
  btn.disabled = true
  try {
    const { submission } = await api("GET", `/api/exams/${EID}/submissions/${btn.dataset.submissionId}`)
    const problemId = submission.submissionDetails?.[0]?.problemSetProblemId
    let problem = null
    if (problemId) {
      try {
        const result = await api("GET", `/api/problem-sets/${PSID}/exam-problems/${encodeURIComponent(problemId)}`)
        problem = { ...result.problemSetProblem, label: result.examLabel }
      } catch (e) {
        if (e.status !== 404) throw e
      }
    }
    showSubmissionResult(submission, { problem })
  } catch (e) {
    toast("读取提交详情失败：" + e.message)
  } finally {
    btn.disabled = false
  }
})


async function loadProblems() {
  $("page-status").textContent = "正在加载题目…"
  try {
    const problems = await getPracticeProblems()
    $("page-status").innerHTML = problems.length ? `共 <strong>${problems.length}</strong> 道题 · 支持点击作答或本地增删` : "暂无题目。"
    $("page-body").innerHTML = `<ul class="exam-problems">${problems.map(problem => {
      const status = problem.status
      const outcome = practiceOutcome(problem)
      const label = status === "ACCEPTED" ? "已通过" : PENDING.has(status) ? "评测中" : status ? "已提交" : "未提交"
      const href = problemUrl(problem.id, problem.type)
      const displayStatus = problem.type === "PROGRAMMING" ? (problem.sampleOnly ? "样例练习" : label)
        : PRACTICE_TYPES[problem.type] || "查看题面"
      const dotClass = status ? statusClass(status) : outcome === "correct" ? "pass" : outcome === "wrong" ? "fail" : ""
      return `<li class="exam-problem-row"><a class="exam-problem" href="${href}">
        <span class="exam-problem-label">${escapeHtml(problem.label)}</span>
        <strong>${escapeHtml(problem.title)}</strong>
        <span class="exam-problem-score">${problem.score == null ? "" : escapeHtml(problem.score) + " 分"}</span>
        <span class="exam-problem-status"><i class="${dotClass}" aria-hidden="true"></i>${displayStatus}</span>
      </a><button class="btn problem-delete" data-delete-problem="${escapeHtml(problem.id)}"
        aria-label="删除 ${escapeHtml(problem.label)} ${escapeHtml(problem.title)}">删除</button></li>`
    }).join("")}</ul>`
  } catch (e) {
    $("page-status").textContent = "读取题目列表失败：" + e.message
  }
}



$("page-body").addEventListener("click", event => {
  const button = event.target.closest("[data-delete-problem]")
  if (!button) return
  const row = button.closest(".exam-problem-row")
  const label = row.querySelector(".exam-problem-label").textContent
  const title = row.querySelector("strong").textContent
  modal("删除题目？", `
    <p>${escapeHtml(label)} · ${escapeHtml(title)}</p>
    <p>确认后，此题将从本地题库移除。</p>
    <p id="delete-problem-error" role="alert" hidden></p>
    <div class="modal-actions">
      <button class="btn" id="btn-cancel-delete">取消</button>
      <button class="btn btn-danger-solid" id="btn-confirm-delete">确认删除</button>
    </div>`)
  const cancel = $("btn-cancel-delete")
  const confirm = $("btn-confirm-delete")
  const error = $("delete-problem-error")
  cancel.focus()
  cancel.onclick = () => {
    $("modal").hidden = true
    button.focus()
  }
  confirm.onclick = async () => {
    confirm.disabled = true
    cancel.disabled = true
    error.hidden = true
    try {
      await api("DELETE", `/api/problem-sets/${PSID}/exam-problems/${encodeURIComponent(button.dataset.deleteProblem)}`)
      if (confirm.isConnected) $("modal").hidden = true
      await loadProblems()
      toast("题目已删除")
    } catch (e) {
      error.textContent = e.status === 501
        ? "当前页面连接的是旧版 mock 服务。请打开新版预览，或重启当前 mock 服务后刷新页面。"
        : "删除失败：" + e.message
      error.hidden = false
    } finally {
      confirm.disabled = false
      cancel.disabled = false
    }
  }
})

$("btn-import-problems").onclick = () => {
  modal("导入题库", `
    <form id="import-problems-form" class="import-form">
      <label for="import-problems-files">选择 PTA 导出 JSON</label>
      <input id="import-problems-files" type="file" accept=".json,application/json" multiple required>
      <p>可同时选择多个 <code>pta-questions-*.json</code> 文件。文件需包含 <code>meta</code>、<code>count</code> 和 <code>items</code>。</p>
      <p id="import-problems-error" role="alert" hidden></p>
      <div class="modal-actions">
        <button class="btn primary" id="btn-import-confirm" type="submit">导入</button>
      </div>
    </form>`)
  const form = $("import-problems-form")
  const input = $("import-problems-files")
  const confirm = $("btn-import-confirm")
  const error = $("import-problems-error")
  input.focus()
  form.onsubmit = async event => {
    event.preventDefault()
    confirm.disabled = true
    input.disabled = true
    error.hidden = true
    try {
      const files = [...input.files]
      if (files.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024) {
        throw new Error("所选文件合计不能超过 5 MiB")
      }
      const items = []
      for (const file of files) {
        let parsed
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())
          parsed = JSON.parse(text)
        } catch {
          throw new Error(`${file.name} 无法读取为 JSON`)
        }
        if (!parsed?.meta || typeof parsed.meta !== "object" || Array.isArray(parsed.meta)
            || !Number.isInteger(parsed.count) || !Array.isArray(parsed.items)) {
          throw new Error(`${file.name} 需要使用 PTA 导出格式（meta、count、items）`)
        }
        if (parsed.count !== parsed.items.length) {
          throw new Error(`${file.name} 的 count 与 items 中的题目数不一致`)
        }
        if (!parsed.items.length || parsed.items.some(item =>
          typeof item?.pid !== "string" || typeof item.stem !== "string"
        )) {
          throw new Error(`${file.name} 须包含带 pid 和 stem 的题目`)
        }
        if (items.length + parsed.items.length > 100) {
          throw new Error("每批最多导入 100 道题")
        }
        const sourceType = typeof parsed.meta.title === "string"
          ? parsed.meta.title.split(" - ", 1)[0] : ""
        for (const item of parsed.items) items.push({ ...item, sourceType })
      }
      const { imported, total } = await api("POST", `/api/problem-sets/${PSID}/import-problems`, { items })
      if (form.isConnected) $("modal").hidden = true
      await loadProblems()
      toast(`已导入 ${imported} 道题，题库共 ${total} 道`, 4500)
    } catch (e) {
      error.textContent = e.message
      error.hidden = false
    } finally {
      confirm.disabled = false
      input.disabled = false
    }
  }
}

async function loadReviewProblem() {
  $("exam-app").classList.add("practice-quiz")
  $("page-status").textContent = "正在加载题目…"
  try {
    const [{ problemSetProblem: problem }, allProblems] = await Promise.all([
      api("GET", `/api/problem-sets/${PSID}/exam-problems/${PSPPID}`),
      getPracticeProblems(),
    ])
    const problems = practiceGroup(allProblems, problem.id)
    const index = problems.findIndex(p => p.id === problem.id)
    const previous = problems[index - 1]
    const next = problems[index + 1]
    const nextControl = next ? `<a class="btn primary review-nav-next" href="${practiceLink(next)}">下一题 →</a>`
      : '<button class="btn review-nav-next" type="button" disabled>下一题 →</button>'
    if (problem.type === "PROGRAMMING") throw new Error("请从题目列表进入作答页")
    const isMultiple = problem.type === "MULTIPLE_CHOICE"
    const isChoice = ["SINGLE_CHOICE", "TRUE_FALSE", "MULTIPLE_CHOICE"].includes(problem.type)
    const blanks = problem.blankAnswers || []
    const canAnswer = isChoice || blanks.length > 0
    const typeLabel = PRACTICE_TYPES[problem.type] || problem.typeLabel || "题目"
    $("page-title").textContent = `${problem.label} ${typeLabel}`
    document.title = $("page-title").textContent + " · PTA 刷题"
    $("page-status").textContent = ""
    $("page-body").innerHTML = `<section id="review-answer-progress" class="answer-progress" aria-live="polite"></section>
    <section class="practice-card review-card">
      <header class="practice-question-meta"><strong>第 ${index + 1} 题</strong>
        <span class="practice-chip type">${escapeHtml(typeLabel)}</span>
        ${problem.score == null ? "" : `<span class="practice-score-pill">${escapeHtml(problem.score)} 分</span>`}
        <span class="practice-label-pill">${escapeHtml(problem.label)}</span>
        ${problem.chapter ? `<span class="practice-chapter-pill">${escapeHtml(problem.chapter)}</span>` : ""}
      </header>
      ${problem.blocks?.length ? `<div class="review-stem">${renderQuestionBlocks(problem.blocks)}</div>`
        : `<p class="review-stem">${escapeHtml(problem.content)}</p>`}
      ${canAnswer ? `<form id="review-answer">
        ${isChoice ? `<fieldset><legend class="visually-hidden">${isMultiple ? "可选择多项" : "请选择一项"}</legend>
          ${problem.options.map(({ value, text }) => `<label class="practice-option">
            <input type="${isMultiple ? "checkbox" : "radio"}" name="answer" value="${escapeHtml(value)}" ${isMultiple ? "" : "required"}>
            <b>${escapeHtml(value)}</b><span>${escapeHtml(text)}</span>
          </label>`).join("")}
        </fieldset>` : `<div class="fill-practice-inputs">${blanks.map((_, i) => `<label>
          第 ${i + 1} 空 <input type="text" name="answer" autocomplete="off" spellcheck="false" required>
        </label>`).join("")}</div>`}
        <button class="btn primary" type="submit">确认</button>
        <p id="review-result" class="practice-feedback" role="status" hidden></p>
      </form>` : `
        ${problem.options?.length ? `<ul>${problem.options.map(({ value, text }) =>
          `<li>${escapeHtml(value)}. ${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
        <p class="review-note">此题可查看导出的题面与选项。</p>`}
      ${problem.referenceAnswer || problem.explanation ? `<details class="question-explanation">
        <summary>参考答案与解析</summary>
        ${problem.referenceAnswer ? `<p><strong>参考答案</strong> ${escapeHtml(problem.referenceAnswer)}</p>` : ""}
        ${problem.explanation ? `<p>${escapeHtml(problem.explanation)}</p>` : ""}
      </details>` : ""}
    </section>
    <nav class="practice-card review-nav" aria-label="切题">
      ${previous ? `<a class="btn review-nav-prev" href="${practiceLink(previous)}">← 上一题</a>` : '<button class="btn review-nav-prev" type="button" disabled>← 上一题</button>'}
      <a class="btn review-nav-home" href="${practiceScope === "browse" ? escapeHtml(homeUrl(practiceFilters)) : "/"}">${practiceScope === "browse" ? "返回筛选" : "返回首页"}</a>
      ${nextControl}
    </nav>`

    const progress = $("review-answer-progress")
    renderAnswerProgress(progress, problems, index)
    if (canAnswer) {
      const form = $("review-answer")
      const explanation = $("page-body").querySelector(".question-explanation")
      const expected = isChoice ? problem.answerKeys || (problem.correctAnswer ? [problem.correctAnswer] : []) : blanks
      const inputs = [...form.querySelectorAll("input")]
      const markAnswer = answer => {
        const values = Array.isArray(answer) ? answer : [answer]
        const normalizeBlank = value => value.replace(/\s+/g, "")
        const match = isChoice ? values.length === expected.length && values.every(value => expected.includes(value))
          : expected.every((value, i) => normalizeBlank(value) === normalizeBlank(values[i] || ""))
        const outcome = !expected.length ? "" : match ? "correct" : "wrong"
        inputs.forEach((input, i) => {
          const label = input.closest("label")
          if (isChoice) {
            input.checked = values.includes(input.value)
            label.classList.toggle("correct", expected.includes(input.value))
            label.classList.toggle("wrong", !!outcome && input.checked && !expected.includes(input.value))
          } else {
            input.value = values[i] || ""
            const blankMatches = normalizeBlank(expected[i]) === normalizeBlank(input.value)
            label.classList.toggle("correct", blankMatches)
            label.classList.toggle("wrong", !blankMatches)
          }
        })
        const result = $("review-result")
        result.hidden = false
        result.className = `practice-feedback ${outcome}`
        result.textContent = !expected.length ? (problem.referenceAnswer ? "请查看参考答案与解析。" : "原导出没有提供参考答案。")
          : outcome === "correct" ? "回答正确" : `回答错误，参考答案为 ${expected.join("、")}。`
        return outcome
      }
      const previousAnswer = practiceAnswers[problem.id]?.answer
      if (previousAnswer && practiceScope !== "wrong") markAnswer(previousAnswer)
      form.onsubmit = event => {
        event.preventDefault()
        const values = new FormData(form).getAll("answer")
        if (!values.length) {
          toast("请至少选择一项")
          return
        }
        const answer = isChoice && !isMultiple ? values[0] : values
        const outcome = markAnswer(answer)
        if (explanation) explanation.open = true
        practiceAnswers[problem.id] = { answer, outcome }
        savePracticeAnswers()
        renderAnswerProgress(progress, problems, index)
      }
    }
  } catch (e) {
    $("page-status").textContent = "读取题目失败：" + e.message
  }
}

async function loadRankings() {
  $("page-status").textContent = "正在加载排名…"
  try {
    const { commonRankings, userById } = await api("GET", `/api/problem-sets/${PSID}/common-rankings`)
    if (!commonRankings.length) {
      $("page-status").textContent = ""
      $("page-body").innerHTML = `
        <section class="practice-card practice-empty-state">
          <span class="practice-empty-badge">公开刷题版</span>
          <h2>暂无排名数据</h2>
          <p>所有刷题进度、错题集与代码草稿均保存在你自己的浏览器本地，不会上传排名。</p>
          <a class="btn primary" href="/">返回首页刷题</a>
        </section>`
      return
    }
    $("page-status").textContent = ""
    $("page-body").innerHTML = `
      <div class="exam-table-wrap">
        <table class="exam-table" aria-label="排名">
          <thead><tr><th>名次</th><th>考生</th><th>分数</th></tr></thead>
          <tbody>${commonRankings.map(({ rank, user, totalScore }) => `<tr>
            <td><strong>${escapeHtml(rank)}</strong></td>
            <td>${escapeHtml(userById[user.userId]?.nickname ?? user.userId)}</td>
            <td>${escapeHtml(totalScore)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>`
  } catch (e) {
    $("page-status").textContent = "读取排名失败：" + e.message
  }
}

async function bootExamPage(title, navId, load) {
  $("answer-view").hidden = true
  $("page-view").hidden = false
  $(navId).classList.add("active")
  $(navId).setAttribute("aria-current", "page")
  $("page-title").textContent = title
  document.title = title
  try {
    const { problemSet } = await api("GET", `/api/problem-sets/${PSID}/exams`)
    $("ps-name").textContent = problemSet.name
  } catch (e) {
    $("ps-name").textContent = "题集信息加载失败"
  }
  await load()
}

const startupQuery = new URLSearchParams(location.search)
if (!startupQuery.has("page") && !requestedProblemId && !startupQuery.has("panel") && !startupQuery.has("layout")) {
  $("exam-app").classList.add("practice-home")
  const announcement = $("site-announcement")
  if (announcement) {
    announcement.showModal()
    window.addEventListener("pageshow", event => {
      if (event.persisted && !announcement.open) announcement.showModal()
    })
  }
  bootExamPage("PTA 刷题", "nav-home", loadPracticeHome)
} else if (startupQuery.get("page") === "submissions") {
  bootExamPage("提交列表", "nav-submissions", loadSubmissions)
} else if (startupQuery.get("page") === "review") {
  bootExamPage("练习", "nav-home", loadReviewProblem)
} else if (startupQuery.get("page") === "problems") {
  $("btn-import-problems").hidden = false
  bootExamPage("题目列表", "nav-problems", loadProblems)
} else if (startupQuery.get("page") === "rankings") {
  bootExamPage("排名", "nav-rankings", loadRankings)
} else {
  boot()
}
